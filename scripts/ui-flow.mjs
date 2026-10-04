import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, '.runtime', 'ui-flow');
await fs.mkdir(runtimeRoot, { recursive: true });
const runtime = await fs.mkdtemp(path.join(runtimeRoot, 'run-'));
const home = path.join(runtime, 'home');
const dataDir = path.join(runtime, 'data');
const resultsPath = path.join(root, 'test-results', 'ui-flow.json');
const fixtureName = 'ui-research-notes';
const fixture = path.join(home, '.agents', 'skills', fixtureName);
const target = path.join(home, '.cursor', 'skills', fixtureName);
const original = '---\nname: ui-research-notes\ndescription: 用于真实界面流程测试的文献记录技能\n---\n# 文献记录\n\n这是隔离测试包，不执行任何脚本。\n';
const evidence = 'paper\tstatus\nfixture\tverified\n';
const alias = '界面验证文献助手';
const report = { status: 'running', startedAt: new Date().toISOString(), steps: [], rendererErrors: [], consoleErrors: [],
  runtime: path.relative(root, runtime), isolatedHome: path.relative(root, home), isolatedDataDir: path.relative(root, dataDir),
  tool: 'cursor', userScope: true, scriptsExecuted: false };
let instance;
let page;
async function record(name, action) {
  report.currentStep = name;
  const startedAt = Date.now();
  try {
    const result = await action();
    report.steps.push({ name, status: 'passed', elapsedMs: Date.now() - startedAt });
    console.log('PASS ' + name);
    return result;
  } catch (error) {
    report.steps.push({ name, status: 'failed', elapsedMs: Date.now() - startedAt, error: error.message });
    throw error;
  }
}
async function idle() {
  await page.locator('.taskbar.working').waitFor({ state: 'hidden', timeout: 30000 });
  const errors = page.locator('.error-banner');
  if (await errors.count()) throw new Error('界面显示错误：' + await errors.innerText());
}
async function state() { return page.evaluate(() => window.manager.call('bootstrap')); }
async function absent(location) {
  await assert.rejects(fs.lstat(location), error => error.code === 'ENOENT');
}
async function navigate(name) {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: new RegExp('^' + name) }).click();
  await page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
}
try {
  await record('创建隔离用户目录和测试技能', async () => {
    for (const relative of ['.agents/skills', '.codex/skills/.system', '.codex/plugins/cache', '.claude/skills', '.claude/plugins/cache', '.cursor/skills']) {
      await fs.mkdir(path.join(home, ...relative.split('/')), { recursive: true });
    }
    await fs.mkdir(path.join(fixture, 'references'), { recursive: true });
    await fs.writeFile(path.join(fixture, 'SKILL.md'), original);
    await fs.writeFile(path.join(fixture, 'references', 'papers.tsv'), evidence);
    const second = path.join(home, '.agents', 'skills', 'ui-control-skill');
    await fs.mkdir(second, { recursive: true });
    await fs.writeFile(path.join(second, 'SKILL.md'), '---\nname: ui-control-skill\ndescription: 不匹配文献检索的对照技能\n---\n对照内容。\n');
    await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  });
  await record('以隐藏桌面窗口启动 Electron', async () => {
    const launchEnv = { ...process.env };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    delete launchEnv.SKILL_MANAGER_DEV_URL;
    instance = await electron.launch({
      args: [path.join(root, 'electron', 'main.mjs')],
      env: { ...launchEnv, SKILL_MANAGER_TEST: '1', SKILL_MANAGER_DATA_DIR: dataDir, SKILL_MANAGER_HOME: home,
        CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
      timeout: 60000,
    });
    page = await instance.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.rendererErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.getByRole('heading', { level: 1, name: '我的技能', exact: true }).waitFor();
    assert.equal((await state()).skills.length, 0);
  });
  await record('通过界面扫描隔离技能目录', async () => {
    await page.getByRole('button', { name: '开始扫描', exact: true }).click();
    await page.locator('.skill-row').filter({ hasText: fixtureName }).waitFor();
    await idle();
    const current = await state();
    assert.equal(current.skills.length, 2);
    assert.ok(current.skills.every(skill => path.relative(home, skill.physicalPath).split(path.sep)[0] !== '..'));
  });
  await record('Ctrl+K 搜索与空结果反馈', async () => {
    await page.keyboard.press('Control+k');
    const search = page.getByRole('textbox', { name: '搜索本地技能', exact: true });
    assert.equal(await search.evaluate(element => element === document.activeElement), true);
    await search.fill('ui-no-result-test');
    await page.getByRole('heading', { name: '没有找到匹配的技能', exact: true }).waitFor();
    await search.fill(fixtureName);
    await page.waitForFunction(() => document.querySelectorAll('.skill-row').length === 1);
    assert.ok((await page.locator('.skill-row').innerText()).includes(fixtureName));
  });
  await record('打开技能详情并查看源码', async () => {
    await page.locator('.skill-row .skill-main').click();
    const detail = page.locator('.detail-panel.is-open');
    await detail.getByRole('heading', { name: fixtureName, exact: true }).waitFor();
    await detail.getByRole('tab', { name: '源码', exact: true }).click();
    await detail.locator('.source-code').filter({ hasText: '这是隔离测试包' }).waitFor();
    await detail.getByRole('tab', { name: '概览', exact: true }).click();
  });
  await record('通过详情收藏、保存中文别名和标签', async () => {
    const detail = page.locator('.detail-panel.is-open');
    await detail.getByRole('button', { name: '收藏技能', exact: true }).click();
    await detail.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
    await idle();
    await detail.getByLabel('中文别名', { exact: true }).fill(alias);
    await detail.getByLabel('标签', { exact: true }).fill('界面测试，文献');
    await detail.getByRole('button', { name: '保存整理', exact: true }).click();
    await detail.getByRole('heading', { name: alias, exact: true }).waitFor();
    await idle();
    const skill = (await state()).skills.find(item => item.physicalPath === fixture);
    assert.equal(skill.alias, alias);
    assert.equal(skill.favorite, true);
    assert.deepEqual(skill.tags, ['界面测试', '文献']);
  });
  await record('通过界面生成 Cursor 用户级安装预览', async () => {
    await page.locator('.detail-panel.is-open').getByRole('button', { name: '安装到工具', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Codex', exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: 'Cursor', exact: true }).check();
    await dialog.getByRole('combobox').selectOption('user');
    await dialog.getByRole('button', { name: '生成变更预览', exact: true }).click();
    const plan = page.getByRole('dialog', { name: '确认文件变更', exact: true });
    await plan.waitFor();
    assert.ok((await plan.innerText()).includes(target));
    assert.equal(await plan.locator('.plan-step').count(), 1);
    assert.equal(await plan.getByRole('button', { name: '确认执行', exact: true }).isEnabled(), true);
    await absent(target);
  });
  await record('确认安装并校验实际文件', async () => {
    await page.getByRole('dialog', { name: '确认文件变更', exact: true }).getByRole('button', { name: '确认执行', exact: true }).click();
    await page.getByRole('dialog', { name: '确认文件变更', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
    await idle();
    assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), original);
    assert.equal(await fs.readFile(path.join(target, 'references', 'papers.tsv'), 'utf8'), evidence);
    const installed = (await state()).skills.flatMap(item => item.deployments);
    assert.equal(installed.length, 1);
    assert.equal(installed[0].tool, 'cursor');
    assert.equal(installed[0].targetPath, target);
    report.installation = { target: path.relative(root, target), sourceUnchanged: await fs.readFile(path.join(fixture, 'SKILL.md'), 'utf8') === original };
  });
  await record('通过操作历史预览并恢复安装', async () => {
    await navigate('操作历史');
    await page.getByRole('button', { name: '预览恢复', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '生成变更预览', exact: true }).click();
    const plan = page.getByRole('dialog', { name: '确认文件变更', exact: true });
    await plan.waitFor();
    assert.ok((await plan.innerText()).includes(target));
    await plan.getByRole('button', { name: '确认执行', exact: true }).click();
    await plan.waitFor({ state: 'hidden', timeout: 30000 });
    await idle();
    await absent(target);
    assert.equal(await fs.readFile(path.join(fixture, 'SKILL.md'), 'utf8'), original);
    assert.equal(await fs.readFile(path.join(fixture, 'references', 'papers.tsv'), 'utf8'), evidence);
    const current = await state();
    assert.equal(current.skills.flatMap(item => item.deployments).length, 0);
    assert.equal(current.operations.length, 2);
    assert.ok(current.operations.every(operation => operation.status === 'completed'));
    report.restoration = { targetRemoved: true, originalPreserved: true, completedOperations: current.operations.length };
  });
  await record('遍历全部导航页并检查设置可见', async () => {
    for (const name of ['我的技能', '按工具查看', '在线发现', '重复与冲突', '更新', '操作历史']) await navigate(name);
    await page.locator('.settings-nav').click();
    await page.getByRole('heading', { level: 1, name: '设置', exact: true }).waitFor();
    await page.getByRole('heading', { name: '扫描目录', exact: true }).waitFor();
    await page.getByRole('heading', { name: '在线来源', exact: true }).waitFor();
    await idle();
    report.navigationPages = ['我的技能', '按工具查看', '在线发现', '重复与冲突', '更新', '操作历史', '设置'];
  });
  assert.deepEqual(report.rendererErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  if (page) report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(-12000);
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (instance) await instance.close().catch(error => { report.closeError = error.message; });
  report.finishedAt = new Date().toISOString();
  delete report.currentStep;
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, steps: report.steps.length, results: path.relative(root, resultsPath), rendererErrors: report.rendererErrors }));
}
