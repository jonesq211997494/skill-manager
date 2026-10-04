import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scanRoots } from '../core/scanner.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageCount = 1000;
const scanIterations = 100;
const queryIterations = 100;
const environment = {
  timestamp: new Date().toISOString(),
  platform: process.platform,
  operatingSystem: os.version(),
  release: os.release(),
  architecture: process.arch,
  node: process.version,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  logicalProcessors: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  freeMemoryBytesAtStart: os.freemem(),
};
const digest = text => createHash('sha256').update(text).digest('hex');
const percentile = (values, percentage) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * percentage) - 1)];
const stats = values => ({
  samples: values.length,
  minMs: Math.min(...values),
  meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
  p50Ms: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  maxMs: Math.max(...values),
});
const temporaryParent = await fs.realpath(os.tmpdir());
const temporaryRoot = await fs.mkdtemp(path.join(temporaryParent, 'skill-manager-benchmark-'));
const dataset = path.join(temporaryRoot, 'skills');
const root = { id: 'benchmark', path: dataset, tools: ['codex', 'cursor'], kind: 'manual', scope: 'user' };
let report;
try {
  await fs.mkdir(dataset);
  let expectedBytes = 0;
  // 每个包只有主说明与一个二进制附件，不执行这些内容。
  for (let offset = 0; offset < packageCount; offset += 20) {
    await Promise.all(Array.from({ length: Math.min(20, packageCount - offset) }, async (_, index) => {
      const id = offset + index;
      const name = 'skill-' + String(id).padStart(4, '0');
      const folder = path.join(dataset, name);
      const instruction = '---\nname: ' + name + '\ndescription: 中文科研技能 ' + (id % 10) + '\n---\n# 技能说明\n类别 ' + (id % 10) + '\n' + '支持数据分析、图表和文件处理。 '.repeat(20);
      const resource = Buffer.alloc(2048, id % 256);
      expectedBytes += Buffer.byteLength(instruction) + resource.byteLength;
      await fs.mkdir(folder);
      await Promise.all([fs.writeFile(path.join(folder, 'SKILL.md'), instruction), fs.writeFile(path.join(folder, 'resource.bin'), resource)]);
    }));
  }
  const scanTimings = [];
  let latest;
  for (let iteration = 0; iteration < scanIterations; iteration++) {
    const started = performance.now();
    latest = await scanRoots([root]);
    scanTimings.push(performance.now() - started);
    if (!latest.complete || latest.skills.length !== packageCount) throw new Error('扫描结果不完整，性能结果无效');
    if ((iteration + 1) % 10 === 0) process.stdout.write('metadata scans: ' + (iteration + 1) + '/' + scanIterations + '\n');
  }
  const skills = latest.skills.map((skill, index) => ({
    ...skill,
    alias: '科研技能 ' + index,
    tags: ['分类' + (index % 5)],
    favorite: index % 13 === 0,
    pinned: index % 31 === 0,
    deployments: [],
  }));
  const workloads = [
    { query: '技能', tool: 'all', scope: 'all', tag: 'all', favorites: false, state: 'all' },
    { query: 'skill-000', tool: 'all', scope: 'all', tag: 'all', favorites: false, state: 'all' },
    { query: '科研 3', tool: 'all', scope: 'all', tag: 'all', favorites: false, state: 'all' },
    { query: '不存在的关键词', tool: 'all', scope: 'all', tag: 'all', favorites: false, state: 'all' },
    { query: '', tool: 'codex', scope: 'user', tag: 'all', favorites: false, state: 'all' },
    { query: '文件处理', tool: 'cursor', scope: 'user', tag: '分类2', favorites: false, state: 'all' },
    { query: '', tool: 'all', scope: 'all', tag: 'all', favorites: true, state: 'all' },
    { query: '', tool: 'all', scope: 'all', tag: 'all', favorites: false, state: 'pinned' },
    { query: '分析 图表', tool: 'all', scope: 'all', tag: '分类4', favorites: false, state: 'all' },
    { query: '', tool: 'all', scope: 'all', tag: 'all', favorites: false, state: 'external' },
  ];
  // 对齐当前列表的筛选、排序和首屏切片；不测量 React 渲染与 IPC。
  function querySkills({ query, tool, scope, tag, favorites, state }) {
    return skills.filter(skill => {
      const text = (skill.name + ' ' + (skill.alias || '') + ' ' + (skill.description || '') + ' ' + (skill.body || skill.raw || '') + ' ' + (skill.tags || []).join(' ')).toLowerCase();
      return (!query.trim() || query.toLowerCase().split(/\s+/).every(word => text.includes(word)))
        && (tool === 'all' || skill.tools?.includes(tool))
        && (scope === 'all' || skill.aliases?.some(item => item.scope === scope) || skill.deployments?.some(item => item.scope === scope))
        && (tag === 'all' || skill.tags?.includes(tag))
        && (!favorites || skill.favorite)
        && (state === 'all' || (state === 'attention' ? skill.health !== 'normal' : state === 'pinned' ? skill.pinned : skill.management === state));
    }).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (a.alias || a.name).localeCompare(b.alias || b.name, 'zh-CN') || a.id.localeCompare(b.id)).slice(0, 40);
  }
  for (const workload of workloads) querySkills(workload);
  const queryTimings = [];
  const resultCounts = [];
  for (let iteration = 0; iteration < queryIterations; iteration++) {
    const started = performance.now();
    const found = querySkills(workloads[iteration % workloads.length]);
    queryTimings.push(performance.now() - started);
    resultCounts.push(found.length);
  }
  const applicationSource = await fs.readFile(path.join(appRoot, 'src', 'App.tsx'));
  report = {
    schemaVersion: 1,
    environment,
    dataset: { synthetic: true, packageCount, filesPerPackage: 2, totalFiles: packageCount * 2, bytes: expectedBytes, instructionBody: '中文科研说明，每包约1KB', attachmentBytesPerPackage: 2048, links: 0 },
    metadataScan: { ...stats(scanTimings), repetitions: scanIterations, timingsMs: scanTimings, finalSkillCount: latest.skills.length, complete: latest.complete, hashPackages: false, cacheState: '生成文件后连续重复扫描，操作系统缓存可能已热；未测试冷启动' },
    query: { ...stats(queryTimings), repetitions: queryIterations, warmupQueries: workloads.length, workloads, timingsMs: queryTimings, firstPageCounts: resultCounts, firstPageSize: 40, method: '复现 src/App.tsx 的内存关键词与组合筛选、排序、首屏切片；排除 React 渲染、IPC、SQLite 读出及界面响应', sourceSHA256: digest(applicationSource) },
    limitations: ['1000 个技能、每包 2 文件的合成数据，不代表文档的 10000 技能与平均 10 文件规模', '不包含完整包附件哈希耗时', '未测量20次应用启动、SSD规格、150%缩放或干净Windows环境', '不以此报告宣称满足文档性能验收阈值'],
    cleanup: { temporaryDirectoryRemoved: false },
  };
} finally {
  // 递归删除之前核对绝对路径仍在已确认的临时目录，且保持本测试生成的名称。
  const resolved = await fs.realpath(temporaryRoot);
  const relative = path.relative(temporaryParent, resolved);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !path.basename(resolved).startsWith('skill-manager-benchmark-')) throw new Error('临时目录清理路径校验失败');
  await fs.rm(resolved, { recursive: true, force: true });
}
report.cleanup.temporaryDirectoryRemoved = true;
const output = path.join(appRoot, 'test-results', 'benchmark.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ metadataScanP95Ms: report.metadataScan.p95Ms, queryP95Ms: report.query.p95Ms, output }) + '\n');
