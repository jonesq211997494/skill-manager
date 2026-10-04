import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagerService } from '../core/service.mjs';
import { buildManifest } from '../core/scanner.mjs';
import { getSkillVersionStatus } from '../shared/version-status.mjs';

async function writeSkill(directory, name, revision = 1) {
  await fs.mkdir(path.join(directory, 'references'), { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: 版本状态集成测试\n---\n# ${name}\n`);
  await fs.writeFile(path.join(directory, 'references', 'revision.txt'), `附件版本 ${revision}\n`);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-version-service-'));
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await fs.mkdir(home);
  await fs.mkdir(project);
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  await fs.mkdir(process.env.CODEX_HOME);
  await fs.mkdir(process.env.CLAUDE_CONFIG_DIR);
  let loggedIn = true;
  let revision = 1;
  let checks = 0;
  let downloads = 0;
  const repository = { id: 51, fullName: 'fixture/skills', url: 'https://github.com/fixture/skills', defaultBranch: 'main' };
  const packages = new Map();
  const auth = {
    getCredential: async () => loggedIn ? { token: 'fixture-only', cacheKey: 'fixture-account' } : null,
    status: async () => ({ authenticated: loggedIn, user: loggedIn ? { id: 1, login: 'fixture' } : null }),
  };
  const manager = new ManagerService({ dataDir, home, auth, fetchImpl: () => { throw new Error('版本测试禁止真实网络'); } });
  t.after(async () => {
    manager.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  for (const registered of manager.store.all('roots')) manager.store.delete('roots', registered.id);
  manager.store.put('projects', 'project', { id: 'project', path: project, name: 'project' });
  const source = name => ({ repositoryId: repository.id, fullName: repository.fullName, url: repository.url,
    ref: 'main', subdir: `skills/${name}`, commit: String(revision).repeat(40) });
  manager.sources.inspect = async (_url, options) => {
    checks++;
    assert.equal(options.forceRefresh, true);
    return { repository, ref: 'main', commit: String(revision).repeat(40), stale: false,
      skills: [...packages.keys()].map(name => ({ name, path: `skills/${name}` })) };
  };
  manager.sources.download = async candidate => {
    downloads++;
    const name = candidate.path.split('/').at(-1);
    const directory = packages.get(name)[revision];
    return { path: directory, source: source(name), files: (await buildManifest(directory)).files };
  };
  async function add(name, { tool = 'codex', scope = 'user', knownSource = true, deployment = true } = {}) {
    const base = scope === 'user' ? home : scope;
    const folder = { codex: '.agents', claude: '.claude', cursor: '.cursor' }[tool];
    const directory = path.join(base, folder, 'skills', name);
    await writeSkill(directory, name);
    const remote = { 1: path.join(dataDir, 'staging', `${name}-1`), 2: path.join(dataDir, 'staging', `${name}-2`) };
    await writeSkill(remote[1], name, 1);
    await writeSkill(remote[2], name, 2);
    packages.set(name, remote);
    const tools = tool === 'codex' ? ['codex', 'cursor'] : [tool];
    const rootId = `${tool}:${scope}`;
    manager.store.put('roots', rootId, { id: rootId, path: path.dirname(directory), tools, scope, kind: 'active', enabled: true });
    const baseline = await buildManifest(directory);
    const record = { id: `deployment-${name}`, tool, scope, targetPath: directory, physicalTarget: directory,
      baseline, baselineHash: baseline.hash, revisionPath: remote[1], source: knownSource ? source(name) : null };
    if (deployment) manager.store.put('deployments', record.id, record);
    return record;
  }
  const skill = deployment => manager.skills().find(item => item.physicalPath === deployment.targetPath);
  return { manager, root, project, dataDir, add, skill,
    setRevision: value => { revision = value; }, setLoggedIn: value => { loggedIn = value; },
    counts: () => ({ checks, downloads }) };
}

test('检查结果回填当前完整包哈希，技能列表和详情都返回可靠版本状态', async t => {
  const f = await fixture(t);
  const installation = await f.add('first');
  await f.manager.scan();
  assert.equal(f.skill(installation).versionStatus.status, 'unchecked');
  const [result] = await f.manager.call('updates.check');
  assert.equal(result.status, 'current');
  const skill = f.skill(installation);
  assert.equal(skill.versionStatus.status, 'current');
  assert.equal(skill.hash, result.localHash);
  assert.equal(skill.manifest.hash, result.localHash);
  assert.equal(skill.manifest.complete, true);
  assert.equal(skill.versionStates[0].checkedAt, result.checkedAt);
  assert.deepEqual(result.checkedSource, installation.source);
  const detail = await f.manager.call('skills.detail', { id: skill.id });
  assert.equal(detail.versionStatus.status, 'current');
});

test('筛选检查仅更新选定技能、工具和范围，保留其它检查记录', async t => {
  const f = await fixture(t);
  const alpha = await f.add('alpha');
  const beta = await f.add('beta', { tool: 'claude' });
  const gamma = await f.add('gamma', { scope: f.project });
  await f.manager.scan();
  const initial = await f.manager.call('updates.check');
  assert.equal(initial.length, 3);
  const untouched = [beta, gamma].map(item => f.manager.store.get('updates', item.id));
  const before = f.counts();
  f.setRevision(2);
  const filtered = await f.manager.call('updates.check', { skillIds: [f.skill(alpha).id], tool: 'codex', scope: 'user' });
  assert.deepEqual(filtered.map(item => item.deploymentId), [alpha.id]);
  assert.equal(filtered[0].status, 'available');
  assert.equal(f.counts().checks - before.checks, 1);
  assert.equal(f.counts().downloads - before.downloads, 1);
  for (let i = 0; i < untouched.length; i++) assert.deepEqual(f.manager.store.get('updates', untouched[i].id), untouched[i]);
  assert.equal(f.manager.store.all('updates').length, 3);
  assert.equal(f.skill(beta).versionStatus.status, 'current');
  assert.equal(f.skill(gamma).versionStatus.status, 'current');
});

test('仅选定工具和项目范围时不会检查其它安装', async t => {
  const f = await fixture(t);
  await f.add('user-install');
  const project = await f.add('project-install', { scope: f.project });
  await f.add('claude-install', { tool: 'claude', scope: f.project });
  await f.manager.scan();
  const result = await f.manager.call('updates.check', { tool: 'codex', scope: f.project });
  assert.deepEqual(result.map(item => item.deploymentId), [project.id]);
  assert.deepEqual(f.counts(), { checks: 1, downloads: 1 });
});

test('Cursor 筛选能检查 .agents 共享安装并显示同一检查结果', async t => {
  const f = await fixture(t);
  const shared = await f.add('shared');
  await f.manager.scan();
  const result = await f.manager.call('updates.check', { tool: 'cursor', scope: 'user' });
  assert.equal(result.length, 1);
  assert.equal(result[0].deploymentId, shared.id);
  const skill = f.skill(shared);
  assert.equal(getSkillVersionStatus(skill, { tool: 'cursor', scope: 'user' }).status, 'current');
  assert.equal(getSkillVersionStatus(skill, { tool: 'codex', scope: 'user' }).status, 'current');
});

test('空检查、未知来源和固定版本均不联网也不要求登录', async t => {
  const f = await fixture(t);
  f.setLoggedIn(false);
  assert.deepEqual(await f.manager.call('updates.check'), []);
  const unknown = await f.add('unknown', { knownSource: false });
  const fixed = await f.add('fixed');
  await f.manager.scan();
  await f.manager.call('skills.organize', { id: f.skill(fixed).id, pinned: true });
  await f.manager.call('updates.check');
  assert.deepEqual(f.counts(), { checks: 0, downloads: 0 });
  assert.equal(f.skill(unknown).versionStatus.status, 'unknown-source');
  assert.equal(f.skill(fixed).versionStatus.status, 'pinned');
  await f.manager.call('skills.organize', { id: f.skill(fixed).id, pinned: false });
  await assert.rejects(f.manager.call('updates.check'), error => error.code === 'GITHUB_LOGIN_REQUIRED');
  assert.deepEqual(f.counts(), { checks: 0, downloads: 0 });
});

test('选中未知来源时不会要求未选中有效来源登录', async t => {
  const f = await fixture(t);
  const unknown = await f.add('selected-unknown', { knownSource: false });
  await f.add('unselected-known');
  await f.manager.scan();
  f.setLoggedIn(false);
  const results = await f.manager.call('updates.check', { skillIds: [f.skill(unknown).id] });
  assert.ok(results.every(item => item.status !== 'current'));
  assert.deepEqual(f.counts(), { checks: 0, downloads: 0 });
});

test('元数据扫描复核已检查附件，保留未变当前状态且本地变化使证据失效', async t => {
  const f = await fixture(t);
  const installation = await f.add('attachments');
  await f.manager.scan();
  await f.manager.call('updates.check');
  const counts = f.counts();
  await f.manager.scan();
  assert.equal(f.skill(installation).versionStatus.status, 'current');
  assert.deepEqual(f.counts(), counts);
  await fs.writeFile(path.join(installation.targetPath, 'references', 'revision.txt'), '用户修改附件\n');
  await f.manager.scan();
  assert.equal(f.skill(installation).versionStatus.status, 'stale');
  assert.deepEqual(f.counts(), counts);
  const [checked] = await f.manager.call('updates.check');
  assert.equal(checked.status, 'local-changed');
  assert.equal(f.skill(installation).versionStatus.status, 'local-changed');
});

test('更新和移除完成后不能复用旧 available/current 证据', async t => {
  const f = await fixture(t);
  const installation = await f.add('updatable');
  await f.manager.scan();
  await f.manager.call('updates.check');
  f.setRevision(2);
  const [update] = await f.manager.call('updates.check');
  assert.equal(update.status, 'available');
  const plan = await f.manager.call('operations.plan', { kind: 'update', deploymentId: installation.id,
    sourcePath: update.remotePath, source: update.source });
  assert.deepEqual(plan.blockers, []);
  const operation = await f.manager.call('operations.execute', { planId: plan.id, digest: plan.digest });
  assert.equal(operation.status, 'completed');
  const after = f.skill(installation);
  assert.notEqual(after.versionStatus.status, 'available');
  assert.notEqual(after.versionStatus.status, 'current');
  await f.manager.call('updates.check');
  assert.equal(f.skill(installation).versionStatus.status, 'current');
  const remove = await f.manager.call('operations.plan', { kind: 'remove', deploymentId: installation.id });
  assert.deepEqual(remove.blockers, []);
  await f.manager.call('operations.execute', { planId: remove.id, digest: remove.digest });
  assert.ok(!f.manager.engine.deployments().some(item => item.id === installation.id));
  const removed = f.skill(installation);
  assert.ok(!removed || removed.versionStatus.status !== 'current');
});