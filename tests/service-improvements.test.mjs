import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ManagerService } from '../core/service.mjs';
import { buildManifest } from '../core/scanner.mjs';

async function writeSkill(location, name, text = '初始正文') {
  await fs.mkdir(location, { recursive: true });
  await fs.writeFile(path.join(location, 'SKILL.md'), `---\nname: ${name}\ndescription: 服务改进隔离测试\n---\n# ${name}\n${text}\n`);
}
async function fixture(t, names = ['sample']) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'skill-manager-improvements-')));
  const identity = await fs.stat(root, { bigint: true });
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const skillsPath = path.join(root, 'original');
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  await fs.mkdir(home, { recursive: true });
  for (const name of names) await writeSkill(path.join(skillsPath, name), name);
  const progress = [];
  const auth = { status: () => ({ authenticated: true, user: { id: 123, login: 'fixture' } }), getCredential: () => ({ token: 'test-fixture-only', cacheKey: 'fixture' }) };
  const manager = new ManagerService({ dataDir, home, auth, onProgress: event => progress.push(event), fetchImpl: () => { throw new Error('隔离测试禁止真实网络'); } });
  manager.store.put('state', 'initialized', true);
  t.after(async () => {
    manager.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), temporaryRoot);
    const current = await fs.stat(root, { bigint: true });
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.ok(path.basename(root).startsWith('skill-manager-improvements-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  const registered = await manager.call('roots.add', { path: skillsPath, tools: ['codex'], scope: 'user' });
  const scanned = await manager.call('scan');
  return { root, home, dataDir, skillsPath, manager, registered, skills: scanned.skills, progress };
}

test('详情重新读取正文和元数据，错误修复后恢复健康状态并保留收藏', async t => {
  const f = await fixture(t);
  const original = f.skills[0];
  await f.manager.call('skills.organize', { id: original.id, favorite: true, alias: '个人别名' });
  await fs.writeFile(path.join(original.physicalPath, 'SKILL.md'), '不含元数据的新正文\n');
  const broken = await f.manager.call('skills.detail', { id: original.id });
  assert.equal(broken.health, 'metadata-error');
  assert.match(broken.body, /不含元数据的新正文/);
  assert.ok(broken.issues.length);
  await writeSkill(original.physicalPath, 'new-name', '修复后的新正文');
  const repaired = await f.manager.call('skills.detail', { id: original.id });
  assert.equal(repaired.name, 'new-name');
  assert.equal(repaired.metadata.name, 'new-name');
  assert.match(repaired.body, /修复后的新正文/);
  assert.equal(repaired.health, 'normal');
  assert.deepEqual(repaired.issues, []);
  assert.equal(repaired.favorite, true);
  assert.equal(repaired.alias, '个人别名');
  assert.equal(repaired.manifest.complete, true);
});

test('取消登记隐藏技能但不删除文件，重新登记扫描恢复原 ID 与收藏', async t => {
  const f = await fixture(t);
  const original = f.skills[0];
  const before = await buildManifest(original.physicalPath);
  await f.manager.call('skills.organize', { id: original.id, favorite: true, tags: ['保留标签'] });
  await f.manager.call('roots.remove', { id: f.registered.id });
  assert.equal(f.manager.skills().length, 0);
  assert.equal(f.manager.store.get('skills', original.id).tracked, false);
  assert.equal((await buildManifest(original.physicalPath)).hash, before.hash);
  await f.manager.call('roots.add', { path: f.skillsPath, tools: ['codex'], scope: 'user' });
  const rescanned = await f.manager.call('scan');
  assert.equal(rescanned.skills.length, 1);
  assert.equal(rescanned.skills[0].id, original.id);
  assert.equal(rescanned.skills[0].favorite, true);
  assert.deepEqual(rescanned.skills[0].tags, ['保留标签']);
  assert.equal(rescanned.skills[0].health, 'normal');
});

test('扫描中取消不发布部分索引或覆盖上一轮扫描记录', async t => {
  const f = await fixture(t);
  const oldSkills = f.manager.store.all('skills');
  const oldScan = f.manager.store.get('state', 'lastScan');
  await writeSkill(path.join(f.skillsPath, 'new-sample'), 'new-sample');
  let cancellation;
  f.manager.onProgress = event => {
    if (event.phase === 'scan' && event.skills > 0 && !cancellation) cancellation = f.manager.call('jobs.cancel', { id: 'scan' });
  };
  await assert.rejects(f.manager.call('scan'), { code: 'CANCELLED' });
  assert.equal((await cancellation).cancelled, true);
  assert.deepEqual(f.manager.store.all('skills'), oldSkills);
  assert.deepEqual(f.manager.store.get('state', 'lastScan'), oldScan);
  assert.equal(f.manager.jobs.has('scan'), false);
  assert.equal(f.manager.queryPromises.has('scan'), false);
});

test('更新检查取消保留已经完成的检查，并保留尚未开始项的旧记录', async t => {
  const f = await fixture(t, ['alpha', 'beta']);
  const candidates = new Map();
  for (const skill of f.skills) {
    const baseline = await buildManifest(skill.physicalPath);
    const remotePath = path.join(f.dataDir, 'staging', `source-${skill.name}`);
    await fs.cp(skill.physicalPath, remotePath, { recursive: true });
    await fs.writeFile(path.join(remotePath, 'remote.txt'), '远端新增文件');
    const source = { repositoryId: skill.name === 'alpha' ? 101 : 102, url: `https://github.com/fixture/${skill.name}`, ref: 'main', subdir: '' };
    const id = `deployment-${skill.name}`;
    f.manager.store.put('deployments', id, { id, targetPath: skill.physicalPath, physicalTarget: skill.physicalPath, tool: 'codex', scope: 'user', source, baseline, baselineHash: baseline.hash });
    candidates.set(source.url, { source, remotePath, name: skill.name });
  }
  // 检查顺序来自技能索引，不能假定不同平台的文件实体 ID 按名称排序。
  const [first, second] = f.manager.skills().flatMap(skill => skill.deployments);
  const previousSecond = { id: second.id, status: 'old-fixture-record', checkedAt: '2020-01-01T00:00:00.000Z' };
  f.manager.store.put('updates', previousSecond.id, previousSecond);
  let inspections = 0;
  f.manager.sources = {
    inspect: async (url, { signal }) => {
      inspections++;
      if (signal.aborted) throw Object.assign(new Error('已取消测试请求'), { code: 'CANCELLED' });
      const fixture = candidates.get(url);
      return { repository: { id: fixture.source.repositoryId, url }, ref: 'main', commit: 'a'.repeat(40), skills: [{ path: '', name: fixture.name }] };
    },
    download: async candidate => {
      const fixture = candidates.get(candidate.repository.url);
      return { path: fixture.remotePath, source: fixture.source };
    },
  };
  let cancellation;
  f.manager.onProgress = event => {
    if (event.kind === 'updates' && event.current === 1 && !cancellation) cancellation = f.manager.call('jobs.cancel', { id: 'updates' });
  };
  await assert.rejects(f.manager.call('updates.check'), { code: 'CANCELLED' });
  assert.equal((await cancellation).cancelled, true);
  assert.equal(f.manager.store.get('updates', first.id).status, 'available');
  assert.deepEqual(f.manager.store.get('updates', second.id), previousSecond);
  assert.ok(inspections <= 2);
  assert.equal(f.manager.jobs.has('updates'), false);
});

test('重复分析支持取消，只保留已完成清单且不修改任何技能文件', async t => {
  const f = await fixture(t, ['alpha', 'beta']);
  const before = await Promise.all(f.skills.map(skill => buildManifest(skill.physicalPath)));
  const ordered = f.manager.skills();
  let cancellation;
  f.manager.onProgress = event => {
    if (event.kind === 'duplicates' && event.current === 1 && !cancellation) cancellation = f.manager.call('jobs.cancel', { id: 'duplicates' });
  };
  await assert.rejects(f.manager.call('duplicates.analyze'), { code: 'CANCELLED' });
  assert.equal((await cancellation).cancelled, true);
  assert.ok(f.manager.store.get('skills', ordered[0].id).manifest.complete);
  assert.equal(f.manager.store.get('skills', ordered[1].id).manifest, null);
  assert.equal(f.manager.jobs.has('duplicates'), false);
  for (let index = 0; index < f.skills.length; index++) assert.equal((await buildManifest(f.skills[index].physicalPath)).hash, before[index].hash);
});

test('文件操作期间不能取消查询或伪装为回滚，操作结束后恢复正常状态', async t => {
  const f = await fixture(t);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  f.manager.engine.execute = async () => { entered(); await hold; return { status: 'completed', steps: [] }; };
  const pending = f.manager.call('operations.execute', { planId: 'controlled-fixture', digest: 'controlled-fixture' });
  await started;
  const controller = new AbortController();
  f.manager.jobs.set('updates', controller);
  const result = await f.manager.call('jobs.cancel', { id: 'updates' });
  assert.equal(result.cancelled, false);
  assert.match(result.message, /不能取消/);
  assert.equal(controller.signal.aborted, false);
  release();
  assert.equal((await pending).status, 'completed');
  assert.equal(f.manager.operationCount, 0);
  f.manager.jobs.delete('updates');
  assert.equal((await f.manager.call('jobs.cancel', { id: 'updates' })).cancelled, false);
});


test('系统技能目录取消扫描登记后仍受只读归属保护', async t => {
  const f = await fixture(t);
  const protectedPath = path.join(f.home, '.codex', 'skills', '.system');
  await fs.mkdir(protectedPath, { recursive: true });
  const registered = await f.manager.call('roots.add', { path: protectedPath, kind: 'plugin', tools: ['codex'], scope: 'user' });
  await f.manager.call('roots.remove', { id: registered.id });
  assert.equal(f.manager.store.get('roots', registered.id), null);
  assert.ok(f.manager.protectedRoots.some(item => item.path === protectedPath));
  await assert.rejects(f.manager.engine.assertWritable(path.join(protectedPath, 'new-skill')), { code: 'READ_ONLY_OWNER' });
  assert.deepEqual(await fs.readdir(protectedPath), []);
});


test('详情读取健康实体不能清除未核验入口，完整扫描确认后才恢复正常', async t => {
  const f = await fixture(t);
  const original = f.skills[0];
  f.manager.store.put('skills', original.id, { ...f.manager.store.get('skills', original.id),
    health: 'incomplete', unverifiedAliases: structuredClone(original.aliases) });
  const details = await f.manager.call('skills.detail', { id: original.id });
  assert.equal(details.manifest.complete, true);
  assert.equal(details.health, 'incomplete');
  assert.equal(details.unverifiedAliases.length, original.aliases.length);
  assert.ok(details.unverifiedAliases.length > 0);
  const scanned = await f.manager.call('scan');
  const confirmed = scanned.skills.find(skill => skill.id === original.id);
  assert.deepEqual(confirmed.unverifiedAliases, []);
  assert.equal(confirmed.health, 'normal');
  assert.equal((await f.manager.call('skills.detail', { id: original.id })).health, 'normal');
});
