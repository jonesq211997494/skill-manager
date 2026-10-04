import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.mjs';
import { buildManifest, scanRoots } from '../core/scanner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime', `version-ui-${Date.now()}`);
const home = path.join(runtime, 'home');
const dataDir = path.join(runtime, 'data');
const skillRoot = path.join(home, '.codex', 'skills');
const checkedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const steps = [];
const errors = [];
const sampleText = (name, version) => `---\nname: ${name}\ndescription: 版本状态界面隔离验证样例\n---\n# ${name}\n\n完整技能内容 ${version}。\n`;
const fixtureNames = ['alpha-current', 'beta-available', 'local-unknown'];
const networkFixtures = {};
for (const name of fixtureNames) {
  const location = path.join(skillRoot, name);
  await fs.mkdir(location, { recursive: true });
  await fs.writeFile(path.join(location, 'SKILL.md'), sampleText(name, 'v1'));
  if (name !== 'local-unknown') {
    const bytes = Buffer.from(sampleText(name, 'v2'));
    const remotePath = path.join(runtime, 'remote', name);
    await fs.mkdir(remotePath, { recursive: true });
    await fs.writeFile(path.join(remotePath, 'SKILL.md'), bytes);
    networkFixtures[name] = {
      id: name === 'alpha-current' ? 91001 : 91002, name,
      commit: (name === 'alpha-current' ? 'a' : 'b').repeat(40),
      tree: (name === 'alpha-current' ? 'c' : 'd').repeat(40),
      blob: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      bytes: bytes.length, content: bytes.toString('utf8'), manifest: await buildManifest(remotePath),
    };
  }
}
const scanRoot = { id: 'version-ui-fixtures', path: skillRoot, kind: 'active', tools: ['codex'], scope: 'user', enabled: true };
const scanned = await scanRoots([scanRoot], { hashPackages: true });
assert.equal(scanned.skills.length, 3);
const store = new Store(dataDir);
try {
  store.put('state', 'initialized', true);
  store.put('roots', scanRoot.id, scanRoot);
  for (const skill of scanned.skills) {
    assert.equal(skill.manifest.complete, true);
    const remote = networkFixtures[skill.name];
    store.put('skills', skill.id, { ...skill, management: remote ? 'managed' : 'external' });
    if (!remote) continue;
    const source = { repositoryId: remote.id, fullName: `ui-fixtures/${skill.name}`, url: `https://github.com/ui-fixtures/${skill.name}`, ref: 'main', subdir: '', commit: 'e'.repeat(40) };
    const deployment = { id: `deployment-${skill.name}`, targetPath: skill.physicalPath, physicalTarget: skill.physicalPath,
      tool: 'codex', scope: 'user', source, baseline: skill.manifest, baselineHash: skill.hash };
    store.put('deployments', deployment.id, deployment);
    store.put('updates', deployment.id, { id: deployment.id, deploymentId: deployment.id, targetPath: skill.physicalPath,
      status: skill.name === 'alpha-current' ? 'current' : 'available', checkedAt,
      source, checkedSource: source, localHash: skill.hash, baselineHash: skill.hash,
      remoteHash: skill.name === 'alpha-current' ? skill.hash : remote.manifest.hash });
  }
} finally { store.close(); }
await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
const env = { ...process.env, SKILL_MANAGER_TEST: '1', SKILL_MANAGER_DATA_DIR: dataDir, SKILL_MANAGER_HOME: home,
  CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
delete env.ELECTRON_RUN_AS_NODE;
const token = 'github_pat_UI_VERSION_TEST_ONLY_' + 'x'.repeat(60);
let app;
let page;
try {
  app = await electron.launch({ args: [path.join(root, 'electron', 'main.mjs')], env, timeout: 60000 });
  await app.evaluate(({ net }, { fixtures, expectedToken }) => {
    globalThis.__versionMock = { requests: [] };
    Object.defineProperty(net, 'fetch', { configurable: true, value: async (url, options = {}) => {
      const route = new URL(url).pathname;
      const authenticated = new Headers(options.headers).get('authorization') === `Bearer ${expectedToken}`;
      globalThis.__versionMock.requests.push({ route, authenticated });
      if (!authenticated) throw new Error('隔离测试禁止匿名访问或使用真实账号');
      const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (route === '/user') return json({ id: 99111, login: 'version-ui-test', name: '版本验证测试账号' });
      const match = route.match(/^\/repos\/ui-fixtures\/([^/]+)(.*)$/);
      const fixture = match && fixtures[match[1]];
      if (!fixture) throw new Error(`未配置的隔离测试请求：${route}`);
      if (!match[2]) return json({ id: fixture.id, name: fixture.name, full_name: `ui-fixtures/${fixture.name}`, html_url: `https://github.com/ui-fixtures/${fixture.name}`, default_branch: 'main', private: false });
      if (match[2].startsWith('/commits/')) return json({ sha: fixture.commit, commit: { tree: { sha: fixture.tree } } });
      if (match[2] === `/git/trees/${fixture.tree}`) return json({ sha: fixture.tree, truncated: false, tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: fixture.blob, size: fixture.bytes }] });
      if (match[2] === `/git/blobs/${fixture.blob}`) return new Response(fixture.content, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      throw new Error(`未配置的隔离测试请求：${route}`);
    } });
  }, { fixtures: networkFixtures, expectedToken: token });
  page = await app.firstWindow();
  page.on('pageerror', failure => errors.push(failure.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole('heading', { name: '我的技能', exact: true }).waitFor();
  const rows = page.locator('.skill-row');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 3);
  const rowFor = name => rows.filter({ has: page.getByRole('button').filter({ hasText: name }) });
  const before = {};
  for (const [name, status, label] of [['alpha-current', 'current', '已是最新'], ['beta-available', 'available', '有更新'], ['local-unknown', 'unknown-source', '来源未知']]) {
    const row = rowFor(name);
    const cell = row.locator('.version-state-label');
    assert.equal(await cell.innerText(), label);
    assert.ok((await cell.getAttribute('class')).split(' ').includes(status));
    const tooltip = await cell.getAttribute('title');
    assert.ok(tooltip.length > 15);
    assert.equal(await row.locator('.version-health').innerText(), '文件正常');
    before[name] = { status, label, tooltip };
  }
  steps.push('真实列表同时显示已是最新、有更新、来源未知；各行保留文件正常副行和独立版本说明');
  await rows.last().scrollIntoViewIfNeeded();
  const geometry = await rows.evaluateAll(items => items.map(item => {
    const rect = selector => { const value = item.querySelector(selector).getBoundingClientRect(); return { x: value.x, y: value.y, right: value.right, bottom: value.bottom }; };
    return { name: item.querySelector('.skill-name').textContent, tools: rect('.row-tools'), status: rect('.row-status'), label: rect('.version-state-label'), health: rect('.version-health'), star: rect('.row-star') };
  }));
  for (const item of geometry) {
    assert.ok(item.tools.right <= item.status.x + 1, `${item.name} 的状态列与工具列不得重叠`);
    assert.ok(item.label.right <= item.star.x + 1, `${item.name} 的版本文字与收藏按钮不得重叠`);
    assert.ok(item.label.bottom <= item.health.y + 1, `${item.name} 的版本与文件状态应分行显示`);
  }
  await page.screenshot({ path: path.join(root, 'test-results', 'version-ui-smoke.png'), fullPage: true });
  steps.push('1366×768 截图与 DOM 几何检查确认状态列、文件状态副行及相邻工具/收藏区域不重叠');
  const filter = page.getByLabel('按状态筛选', { exact: true });
  for (const [status, name] of [['current', 'alpha-current'], ['available', 'beta-available'], ['unknown-source', 'local-unknown']]) {
    await filter.selectOption(`version:${status}`);
    assert.equal(await rows.count(), 1);
    assert.match(await rows.innerText(), new RegExp(name));
  }
  steps.push('最新版本、有更新、未知来源筛选均只显示相应技能');
  const requestsBefore = await app.evaluate(() => globalThis.__versionMock.requests.length);
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByText(/当前范围没有可核验的在线来源/).waitFor();
  assert.equal(await app.evaluate(() => globalThis.__versionMock.requests.length), requestsBefore);
  assert.equal(requestsBefore, 0);
  steps.push('来源未知范围点击检查更新给出说明，不登录且不请求网络');
  await filter.selectOption('all');
  await page.getByRole('button', { name: '登录后检查更新', exact: true }).click();
  await page.getByLabel('GitHub 个人访问令牌', { exact: true }).fill(token);
  await page.getByRole('button', { name: '验证并登录', exact: true }).click();
  await page.getByText('@version-ui-test', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: '我的技能', exact: false }).first().click();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByText('版本检查结果已更新，可在列表和“更新”页查看。', { exact: true }).waitFor({ timeout: 30000 });
  const after = await page.evaluate(() => window.manager.call('bootstrap'));
  assert.equal(after.skills.length, 3);
  assert.equal(after.updates.length, 2);
  for (const item of after.updates) {
    assert.equal(item.status, 'available', JSON.stringify(item.error));
    assert.ok(Date.parse(item.checkedAt) > Date.parse(checkedAt));
    assert.ok(item.localHash && item.remoteHash && item.localHash !== item.remoteHash);
  }
  assert.equal(await rowFor('alpha-current').locator('.version-state-label').innerText(), '有更新');
  assert.equal(await rowFor('local-unknown').locator('.version-state-label').innerText(), '来源未知');
  steps.push('通过界面登录隔离假账号后检查更新，真实业务层完成完整包下载比较并刷新时间；alpha 从已是最新变为有更新');
  const requests = await app.evaluate(() => globalThis.__versionMock.requests);
  assert.ok(requests.some(item => item.route.includes('/git/blobs/')));
  assert.ok(requests.every(item => item.authenticated));
  assert.equal((await page.locator('body').innerText()).includes(token), false);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(root, 'test-results', 'version-ui-smoke.json'), JSON.stringify({ status: 'passed', version: '0.1.2',
    checkedAt: new Date().toISOString(), viewport: { width: 1366, height: 768 }, steps, before,
    after: after.skills.map(item => ({ name: item.name, status: item.versionStatus.status, checkedAt: item.versionStatus.checkedAt })),
    geometry, requests, rendererErrors: errors, network: '全部响应在隔离 Electron 主进程模拟；未使用真实凭据、账号或网络。' }, null, 2));
  console.log(`版本状态界面 ${steps.length} 项验证通过。`);
} catch (failure) {
  if (page) await page.screenshot({ path: path.join(root, 'test-results', 'version-ui-smoke.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(root, 'test-results', 'version-ui-smoke.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(), steps, rendererErrors: errors, error: failure.message }, null, 2));
  throw failure;
} finally { await app?.close(); }
