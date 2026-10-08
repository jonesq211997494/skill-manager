import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const { values: args } = parseArgs({ options: {
  exe: { type: 'string' }, version: { type: 'string' }, home: { type: 'string' },
  'data-dir': { type: 'string' }, owner: { type: 'string' }, phase: { type: 'string' },
  output: { type: 'string' }, seed: { type: 'boolean', default: false },
} });
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('安装生命周期测试只能在 GitHub 托管的 Windows runner 上执行。');
}
for (const key of ['exe', 'version', 'home', 'data-dir', 'owner', 'phase', 'output']) {
  if (!args[key]) throw new Error(`缺少参数 --${key}`);
}
const dataDir = path.resolve(args['data-dir']);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
if (!samePath(dataDir, path.join(process.env.APPDATA, 'SkillManagerDesktop'))) throw new Error('必须验证真实的默认应用数据目录。');
if ((await fs.readFile(path.join(dataDir, '.installer-lifecycle-owner'), 'utf8')).trim() !== args.owner) throw new Error('测试数据所有权标记不一致。');
const name = `installer-lifecycle-${args.phase}`;
const library = path.join(dataDir, 'library');
const skillFile = path.join(library, name, 'SKILL.md');
const backupFile = path.join(dataDir, 'backups', `${name}.txt`);
const skillText = `---\nname: ${name}\ndescription: 安装生命周期合成测试数据\n---\n# 安装与升级验证\n保留此技能及设置。\n`;
const backupText = `synthetic-backup:${args.owner}:${args.phase}\n`;
const expectedSettings = { theme: 'dark', fontSize: 16, backupDays: 67 };
await fs.mkdir(args.home, { recursive: true });
const env = { ...process.env, SKILL_MANAGER_TEST: '1', SKILL_MANAGER_HOME: args.home,
  CODEX_HOME: path.join(args.home, '.codex'), CLAUDE_CONFIG_DIR: path.join(args.home, '.claude') };
// 保留真实 APPDATA；覆盖数据目录会掩盖卸载程序误删默认数据的回归。
delete env.SKILL_MANAGER_DATA_DIR;
delete env.ELECTRON_RUN_AS_NODE;
delete env.SKILL_MANAGER_DEV_URL;
const instance = await electron.launch({ executablePath: args.exe, args: [], env, timeout: 60000 });
const rendererErrors = [];
let result;
try {
  const page = await instance.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.getByRole('heading', { name: '我的技能', exact: true }).waitFor({ timeout: 30000 });
  const info = await instance.evaluate(({ app }) => ({
    packaged: app.isPackaged, version: app.getVersion(), executable: process.execPath,
    userData: app.getPath('userData'), electron: process.versions.electron,
  }));
  if (!info.packaged || info.version !== args.version || !samePath(info.executable, args.exe) || !samePath(info.userData, dataDir)) {
    throw new Error(`安装版进程、版本或数据路径不符合预期：${JSON.stringify(info)}`);
  }
  const call = async (method, values = {}) => {
    const response = await page.evaluate(({ method, values }) => window.manager.call(method, values), { method, values });
    if (response?.ok === false) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response;
  };
  if (args.seed) {
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.mkdir(path.dirname(backupFile), { recursive: true });
    await fs.writeFile(skillFile, skillText);
    await fs.writeFile(backupFile, backupText);
    await call('settings.save', expectedSettings);
    await call('roots.add', { path: library });
    await call('scan');
  }
  const data = await call('bootstrap');
  for (const [key, value] of Object.entries(expectedSettings)) {
    if (data.settings[key] !== value) throw new Error(`设置 ${key} 未保留：${data.settings[key]}`);
  }
  if (!data.roots.some(root => samePath(root.path, library))) throw new Error('技能目录登记未保留。');
  if (!data.skills.some(skill => skill.name === name)) throw new Error('技能索引未保留。');
  // 升级后必须实际重新扫描成功，不能只看旧数据库中仍存在的条目。
  await call('scan');
  const rescanned = await call('bootstrap');
  const skill = rescanned.skills.find(candidate => candidate.name === name);
  if (!skill || skill.health !== 'normal') throw new Error(`安装后技能不可用：${JSON.stringify(skill)}`);
  if ((await fs.readFile(skillFile, 'utf8')) !== skillText || (await fs.readFile(backupFile, 'utf8')) !== backupText) {
    throw new Error('技能或备份内容在安装生命周期中发生变化。');
  }
  if (rendererErrors.length) throw new Error(rendererErrors.join('\n'));
  result = { status: 'passed', checkedAt: new Date().toISOString(), phase: args.phase,
    seeded: args.seed, ...info, settings: expectedSettings, skill: { name: skill.name, health: skill.health }, rendererErrors };
} finally {
  await instance.close();
}
// 在退出并关闭 WAL 后核验数据库，卸载前后对相同文件做完整性与哈希比较。
const databasePath = path.join(dataDir, 'index.sqlite');
const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const check = database.prepare('PRAGMA quick_check').get();
  if (check.quick_check !== 'ok') throw new Error(`数据库完整性检查失败：${JSON.stringify(check)}`);
} finally { database.close(); }
result.preservedFiles = [];
for (const file of [databasePath, skillFile, backupFile, path.join(dataDir, '.installer-lifecycle-owner')]) {
  result.preservedFiles.push({ path: file, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
}
await fs.mkdir(path.dirname(args.output), { recursive: true });
await fs.writeFile(args.output, JSON.stringify(result, null, 2));
console.log(`安装版 ${args.version} 启动、默认数据目录、设置、技能扫描与数据库检查通过。`);
