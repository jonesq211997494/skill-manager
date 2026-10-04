import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanRoots, buildManifest, analyzeDuplicates } from '../core/scanner.mjs';
import { discoverRoots, inspectAdapters, readConfigStates } from '../core/adapters.mjs';

const metadata = (name = 'sample') => `---\nname: ${name}\ndescription: 中文描述\ncustom-field:\n  enabled: true\n---\n# 技能正文\n`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-scanner-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
async function putSkill(folder, name = 'sample', extra = {}) {
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'SKILL.md'), metadata(name));
  for (const [name, content] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await fs.writeFile(path.join(folder, name), content);
  }
}
const rootInput = (location, extra = {}) => ({ id: 'test-root', path: location, kind: 'active', tools: ['codex'], scope: 'user', ...extra });

test('容器展开、包内示例不作为技能，扩展元数据与原文保留', async t => {
  const root = await fixture(t);
  await putSkill(path.join(root, '.system', 'first'), 'first', { 'references/SKILL.md': metadata('example') });
  await putSkill(path.join(root, '.system', 'second'), 'second');
  const result = await scanRoots([rootInput(root)]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.skills.map(skill => skill.name), ['first', 'second']);
  assert.equal(result.skills[0].metadata['custom-field'].enabled, true);
  assert.equal(result.skills[0].sessionEvidence, 'none');
  assert.match(result.skills[0].body, /技能正文/);
  assert.equal(await fs.readFile(path.join(root, '.system', 'first', 'SKILL.md'), 'utf8'), metadata('first'));
});

test('Junction 入口与物理目录合并实体，保留两个项目范围与工具', async t => {
  const root = await fixture(t);
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  await putSkill(actual);
  await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await scanRoots([
    rootInput(actual, { id: 'actual', scope: path.join(root, 'project-a') }),
    rootInput(alias, { id: 'alias', scope: path.join(root, 'project-b'), tools: ['cursor'] }),
  ]);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].aliases.length, 2);
  assert.equal(result.skills[0].scopes.length, 2);
  assert.deepEqual(result.skills[0].tools, ['codex', 'cursor']);
  assert.equal(result.skills[0].aliases[1].link, true);
  assert.equal(analyzeDuplicates(result.skills).find(group => group.type === 'alias').canDelete, false);
});

test('容器的 Junction 别名也保留子技能入口', async t => {
  const root = await fixture(t);
  const actual = path.join(root, 'actual');
  await putSkill(path.join(actual, 'nested'));
  const alias = path.join(root, 'alias');
  await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await scanRoots([rootInput(root)]);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].aliases.length, 2);
});

test('循环及断链明确报告，正常根继续扫描', async t => {
  const root = await fixture(t);
  const container = path.join(root, 'container');
  await fs.mkdir(container);
  await fs.symlink(container, path.join(container, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  const gone = path.join(root, 'gone');
  await fs.mkdir(gone);
  await fs.symlink(gone, path.join(container, 'broken'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.rmdir(gone);
  await putSkill(path.join(root, 'valid'));
  const result = await scanRoots([rootInput(container), rootInput(path.join(root, 'valid'), { id: 'valid' })]);
  assert.equal(result.complete, false);
  assert.equal(result.skills.length, 1);
  assert.ok(result.issues.some(problem => problem.code === 'LINK_CYCLE'));
  assert.ok(result.issues.some(problem => problem.code === 'PATH_MISSING'));
});

test('PDF 和隐藏文件参与哈希，主说明相同不等于包相同', async t => {
  const root = await fixture(t);
  await putSkill(path.join(root, 'first'), 'same', { '.hidden': 'hidden', 'paper.pdf': Buffer.from([0, 1, 2, 3]) });
  await putSkill(path.join(root, 'second'), 'same', { '.hidden': 'hidden', 'paper.pdf': Buffer.from([0, 1, 2, 4]) });
  const result = await scanRoots([rootInput(root)], { hashPackages: true });
  assert.notEqual(result.skills[0].hash, result.skills[1].hash);
  assert.ok(result.skills[0].manifest.files.some(file => file.path === '.hidden'));
  const groups = analyzeDuplicates(result.skills);
  assert.ok(groups.some(group => group.type === 'partial'));
  assert.ok(groups.some(group => group.type === 'name-conflict'));
  assert.ok(!groups.some(group => group.type === 'identical'));
});

test('完整同内容独立保留，.git 不参与技能指纹', async t => {
  const root = await fixture(t);
  await putSkill(path.join(root, 'first'), 'same', { 'script.js': 'export const a=1;', '.git/index': 'one' });
  await putSkill(path.join(root, 'second'), 'same', { 'script.js': 'export const a=1;', '.git/index': 'two' });
  const result = await scanRoots([rootInput(root)], { hashPackages: true });
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills[0].hash, result.skills[1].hash);
  const group = analyzeDuplicates(result.skills).find(item => item.type === 'identical');
  assert.equal(group.skillIds.length, 2);
  assert.equal(group.canDelete, false);
});

test('包外目录链接不跟随，清单不完整且不得声明完全相同', async t => {
  const root = await fixture(t);
  await putSkill(path.join(root, 'package'));
  await fs.mkdir(path.join(root, 'external'));
  await fs.writeFile(path.join(root, 'external', 'private.pdf'), 'private');
  await fs.symlink(path.join(root, 'external'), path.join(root, 'package', 'reference'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = await buildManifest(path.join(root, 'package'));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.hash, null);
  assert.ok(manifest.issues.some(problem => problem.code === 'EXTERNAL_LINK'));
  assert.ok(!manifest.files.some(file => file.path.includes('private.pdf')));
});

test('损坏 YAML 及缺字段候选不消失', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'broken'));
  await fs.writeFile(path.join(root, 'broken', 'SKILL.md'), '---\nname: [not valid\n---\n正文');
  const result = await scanRoots([rootInput(root)]);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].health, 'metadata-error');
  assert.equal(result.skills[0].name, 'broken');
  assert.match(result.skills[0].raw, /not valid/);
});

test('预算和取消产生未完成报告，不生成部分内容的完整指纹', async t => {
  const root = await fixture(t);
  await putSkill(path.join(root, 'first'));
  await putSkill(path.join(root, 'second'));
  const scan = await scanRoots([rootInput(root)], { maxEntries: 1 });
  assert.equal(scan.complete, false);
  assert.ok(scan.issues.some(problem => problem.code === 'ENTRY_BUDGET'));
  const manifest = await buildManifest(path.join(root, 'first'), { maxFileBytes: 2 });
  assert.equal(manifest.complete, false);
  assert.equal(manifest.hash, null);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await scanRoots([rootInput(root)], { signal: controller.signal });
  assert.equal(cancelled.complete, false);
  assert.ok(cancelled.issues.some(problem => problem.code === 'SCAN_CANCELLED'));
});

test('插件扫描只读归属不能被普通入口覆盖', async t => {
  const root = await fixture(t);
  await putSkill(root);
  const result = await scanRoots([rootInput(root, { id: 'plugin', kind: 'plugin' }), rootInput(root)]);
  assert.equal(result.skills[0].management, 'readonly');
});

test('适配器按主目录与环境覆盖发现，并保留共享目录归属', async t => {
  const home = await fixture(t);
  const custom = path.join(home, 'custom-codex');
  const project = path.join(home, 'project');
  await fs.mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
  const roots = await discoverRoots({ home, projects: [project], env: { CODEX_HOME: custom } });
  const shared = roots.find(root => root.path === path.join(home, '.agents', 'skills'));
  assert.deepEqual(shared.tools, ['codex', 'cursor']);
  assert.equal(shared.exists, true);
  assert.ok(roots.some(root => root.path === path.join(custom, 'skills')));
  assert.ok(roots.some(root => root.scope === project && root.tools.includes('claude')));
  const adapters = await inspectAdapters({ home, env: {} });
  assert.equal(adapters.length, 3);
  assert.ok(adapters.every(adapter => adapter.capabilities.nativeDisable === false));
});

test('读取 Codex 停用配置且不返回凭据或修改配置', async t => {
  const home = await fixture(t);
  const skillPath = path.join(home, '.agents', 'skills', 'sample');
  await putSkill(skillPath);
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  const text = `secret_key = "do-not-return"\n[[skills.config]]\npath = ${JSON.stringify(path.join(skillPath, 'SKILL.md'))}\nenabled = false\n`;
  const configPath = path.join(home, '.codex', 'config.toml');
  await fs.writeFile(configPath, text);
  const scan = await scanRoots([rootInput(skillPath)]);
  const result = await readConfigStates(scan.skills, { home, env: {} });
  assert.equal(result.skills[0].configState, 'disabled');
  assert.ok(!JSON.stringify(result).includes('do-not-return'));
  assert.equal(await fs.readFile(configPath, 'utf8'), text);
});

test('包内与临时目录同名前缀的用户资料仍参与完整哈希', async t => {
  const root = await fixture(t);
  const packagePath = path.join(root, 'normal-package');
  await putSkill(packagePath, 'same', { '.skill-manager-stage-user/custom.txt': '用户资料' });
  const before = await buildManifest(packagePath);
  assert.ok(before.files.some(file => file.path === '.skill-manager-stage-user/custom.txt'));
  await fs.writeFile(path.join(packagePath, '.skill-manager-stage-user', 'custom.txt'), '资料已修改');
  const after = await buildManifest(packagePath);
  assert.notEqual(before.hash, after.hash);
  await putSkill(path.join(root, '.skill-manager-stage-controlled'));
  await putSkill(path.join(root, '.skill-manager-retired-controlled'));
  const scan = await scanRoots([rootInput(root)]);
  assert.equal(scan.skills.length, 1);
  assert.equal(scan.skills[0].name, 'same');
});

test('自动候选缺失可以跳过，手动缺失和扫描前已存在的目录仍报告异常', async t => {
  const home = await fixture(t);
  const roots = await discoverRoots({ home, env: {} });
  const first = await scanRoots(roots);
  assert.equal(first.complete, true);
  assert.ok(first.roots.every(root => root.skipped && root.status === 'expected-missing'));
  const manual = await scanRoots([rootInput(path.join(home, 'manual-missing'), { kind: 'manual' })]);
  assert.equal(manual.complete, false);
  assert.ok(manual.issues.some(problem => problem.code === 'PATH_MISSING'));
  const stale = await scanRoots([{ ...roots[0], exists: true, status: 'available' }]);
  assert.equal(stale.complete, false);
});

test('Codex 已知系统安装目录只读，任意手动 .system 名称不推断归属', async t => {
  const home = await fixture(t);
  const systemSkill = path.join(home, '.codex', 'skills', '.system', 'official');
  const manualSkill = path.join(home, 'manual', '.system', 'personal');
  await putSkill(systemSkill, 'official');
  await putSkill(manualSkill, 'personal');
  const roots = await discoverRoots({ home, env: {} });
  const result = await scanRoots([...roots, rootInput(path.join(home, 'manual'), { id: 'manual', kind: 'manual' })]);
  assert.equal(result.skills.find(skill => skill.name === 'official').management, 'readonly');
  assert.equal(result.skills.find(skill => skill.name === 'personal').management, 'external');
});
