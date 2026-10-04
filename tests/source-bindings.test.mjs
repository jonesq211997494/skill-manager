import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ManagerService } from '../core/service.mjs';
import { buildManifest } from '../core/scanner.mjs';

async function fixture(t, { different = false, readonly = false } = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'skill-manager-bindings-')));
  const identity = await fs.stat(root, { bigint: true });
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const localPath = path.join(root, 'original', 'sample');
  const remotePath = path.join(dataDir, 'staging', 'source-binding-fixture');
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  await fs.mkdir(localPath, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(localPath, 'SKILL.md'), '---\nname: sample\ndescription: 来源关联隔离测试\n---\n# 本地原件\n');
  await fs.writeFile(path.join(localPath, 'payload.txt'), '原始附件');
  await fs.cp(localPath, remotePath, { recursive: true });
  if (different) await fs.writeFile(path.join(remotePath, 'payload.txt'), '不同的来源内容');
  const auth = { status: () => ({ authenticated: true, user: { id: 123, login: 'fixture-only' } }), getCredential: () => ({ token: 'fixture-only-fake-token', cacheKey: 'fixture' }) };
  const manager = new ManagerService({ dataDir, home, auth, fetchImpl: () => { throw new Error('隔离测试禁止真实网络'); } });
  manager.store.put('state', 'initialized', true);
  t.after(async () => {
    manager.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), temporaryRoot);
    const current = await fs.stat(root, { bigint: true });
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.ok(path.basename(root).startsWith('skill-manager-bindings-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  await manager.call('roots.add', { path: path.dirname(localPath), kind: readonly ? 'plugin' : 'manual', tools: ['codex'], scope: 'user' });
  const scanned = await manager.call('scan');
  const skill = scanned.skills[0];
  const repository = { id: 778, fullName: 'fixture/skills', url: 'https://github.com/fixture/skills', defaultBranch: 'main' };
  const source = { repositoryId: repository.id, fullName: repository.fullName, url: repository.url, ref: 'main', subdir: 'skills/sample', commit: 'a'.repeat(40) };
  const candidate = { path: source.subdir, name: 'sample', repository, ref: 'main', commit: source.commit };
  const calls = [];
  manager.sources = {
    inspect: async (url, options) => { calls.push({ method: 'inspect', url, options }); return { repository, ref: 'main', commit: source.commit, skills: [candidate], stale: false }; },
    download: async (value, options) => { calls.push({ method: 'download', value, options }); return { path: remotePath, source: { ...source } }; },
  };
  return { root, manager, skill, localPath, remotePath, source, candidate, repository, calls };
}

async function preview(f) { return f.manager.call('skills.source.preview', { id: f.skill.id, candidate: f.candidate }); }
async function bind(f) { const result = await preview(f); return f.manager.call('skills.source.bind', { previewId: result.id }); }

test('只读技能经过来源检查、预览和关联后保持原件与只读归属，完整一致才标记最新', async t => {
  const f = await fixture(t, { readonly: true });
  const before = await buildManifest(f.localPath);
  const inspected = await f.manager.call('skills.source.inspect', { id: f.skill.id, url: f.repository.url });
  assert.equal(inspected.repository.id, 778);
  const comparison = await preview(f);
  assert.equal(comparison.identical, true);
  assert.deepEqual(comparison.files, []);
  const linked = await f.manager.call('skills.source.bind', { previewId: comparison.id });
  assert.equal(linked.management, 'readonly');
  assert.equal(linked.versionStatus.status, 'current');
  assert.equal(linked.sourceBinding.trackingOnly, true);
  assert.equal(linked.sourceBinding.baselineHash, before.hash);
  assert.equal((await buildManifest(f.localPath)).hash, before.hash);
  assert.equal(f.manager.engine.deployments().length, 0);
  assert.equal(f.manager.store.get('source-previews', comparison.id), null);
  assert.deepEqual(f.calls.map(item => item.method), ['inspect', 'download']);
});

test('缺少历史基线时不同内容始终显示与来源不同，不冒充远端更新', async t => {
  const f = await fixture(t, { different: true });
  const before = await buildManifest(f.localPath);
  const linked = await bind(f);
  assert.equal(linked.sourceBinding.baseline, null);
  assert.equal(linked.sourceBinding.baselineHash, null);
  assert.equal(linked.versionStatus.status, 'different');
  await fs.writeFile(path.join(f.remotePath, 'payload.txt'), '另一份远端内容');
  const results = await f.manager.call('updates.check', { skillIds: [f.skill.id] });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'different');
  assert.equal(results[0].trackingOnly, true);
  assert.equal(results[0].localChanged, null);
  assert.equal(results[0].remoteChanged, null);
  assert.equal((await buildManifest(f.localPath)).hash, before.hash);
  assert.equal(f.manager.engine.deployments().length, 0);
});

test('可靠关联基线可跟踪更新但不授予覆盖或移除原件的权限', async t => {
  const f = await fixture(t);
  const linked = await bind(f);
  await fs.writeFile(path.join(f.remotePath, 'payload.txt'), '新远端版本');
  const results = await f.manager.call('updates.check');
  assert.equal(results[0].status, 'available');
  assert.equal(results[0].bindingId, linked.sourceBinding.id);
  assert.equal(results[0].trackingOnly, true);
  for (const kind of ['update', 'remove']) {
    const plan = await f.manager.call('operations.plan', { kind, deploymentId: linked.sourceBinding.id, sourcePath: f.remotePath, force: true });
    assert.equal(plan.blockers[0].code, 'NOT_MANAGED');
    assert.equal(plan.steps.length, 0);
  }
  assert.equal(await fs.readFile(path.join(f.localPath, 'payload.txt'), 'utf8'), '原始附件');
  assert.equal(f.manager.engine.deployments().length, 0);
});

test('最初不同的内容后来完整一致时才建立可靠基线', async t => {
  const f = await fixture(t, { different: true });
  await bind(f);
  await fs.writeFile(path.join(f.remotePath, 'payload.txt'), '原始附件');
  const results = await f.manager.call('updates.check');
  assert.equal(results[0].status, 'current');
  const binding = f.manager.store.get('source-bindings', f.skill.id);
  assert.ok(binding.baseline.complete);
  assert.equal(binding.baselineHash, (await buildManifest(f.localPath)).hash);
  assert.equal(f.manager.skills()[0].versionStatus.status, 'current');
});

test('预览后本地原件变化使关联计划过期，保留用户改动', async t => {
  const f = await fixture(t);
  const comparison = await preview(f);
  await fs.writeFile(path.join(f.localPath, 'payload.txt'), '用户预览后的改动');
  await assert.rejects(f.manager.call('skills.source.bind', { previewId: comparison.id }), { code: 'PLAN_STALE' });
  assert.equal(f.manager.store.get('source-bindings', f.skill.id), null);
  assert.equal(await fs.readFile(path.join(f.localPath, 'payload.txt'), 'utf8'), '用户预览后的改动');
});

test('远端预览包被篡改时拒绝关联，原文件与管理状态不变', async t => {
  const f = await fixture(t, { readonly: true });
  const before = await buildManifest(f.localPath);
  const comparison = await preview(f);
  await fs.writeFile(path.join(f.remotePath, 'payload.txt'), '被篡改的来源');
  await assert.rejects(f.manager.call('skills.source.bind', { previewId: comparison.id }), { code: 'PLAN_STALE' });
  assert.equal(f.manager.store.get('source-bindings', f.skill.id), null);
  assert.equal(f.manager.skills()[0].management, 'readonly');
  assert.equal((await buildManifest(f.localPath)).hash, before.hash);
});

test('解除来源关联只删除关联与检查记录，不改原件或收藏', async t => {
  const f = await fixture(t);
  const before = await buildManifest(f.localPath);
  await f.manager.call('skills.organize', { id: f.skill.id, favorite: true });
  const linked = await bind(f);
  const result = await f.manager.call('skills.source.unbind', { id: f.skill.id });
  assert.equal(result.sourceBinding, null);
  assert.equal(result.favorite, true);
  assert.equal(result.management, 'external');
  assert.equal(result.versionStatus.status, 'unknown-source');
  assert.equal(f.manager.store.get('updates', linked.sourceBinding.id), null);
  assert.equal((await buildManifest(f.localPath)).hash, before.hash);
});

test('已有受管理在线来源时禁止重绑，预览期间新增受管理来源也不能绕过', async t => {
  const f = await fixture(t);
  const comparison = await preview(f);
  const baseline = await buildManifest(f.localPath);
  f.manager.store.put('deployments', 'managed', { id: 'managed', targetPath: f.localPath, physicalTarget: f.localPath, tool: 'codex', scope: 'user', source: f.source, baseline, baselineHash: baseline.hash });
  for (const [method, args] of [
    ['skills.source.inspect', { id: f.skill.id, url: f.repository.url }],
    ['skills.source.preview', { id: f.skill.id, candidate: f.candidate }],
    ['skills.source.bind', { previewId: comparison.id }],
  ]) await assert.rejects(f.manager.call(method, args), { code: 'SOURCE_ALREADY_MANAGED' });
  assert.equal(f.manager.store.get('source-bindings', f.skill.id), null);
  assert.equal(f.manager.engine.deployments().length, 1);
});

test('过期预览不能关联，且在线检查和比较都必须先登录', async t => {
  const f = await fixture(t);
  const comparison = await preview(f);
  f.manager.store.put('source-previews', comparison.id, { ...comparison, checkedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() });
  await assert.rejects(f.manager.call('skills.source.bind', { previewId: comparison.id }), { code: 'PLAN_STALE' });
  const calls = f.calls.length;
  f.manager.auth.getCredential = () => null;
  await assert.rejects(f.manager.call('skills.source.inspect', { id: f.skill.id, url: f.repository.url }), { code: 'GITHUB_LOGIN_REQUIRED' });
  await assert.rejects(f.manager.call('skills.source.preview', { id: f.skill.id, candidate: f.candidate }), { code: 'GITHUB_LOGIN_REQUIRED' });
  assert.equal(f.calls.length, calls);
});


function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('不同来源的比较预览不能共享进行中的查询，第二个请求明确报忙', async t => {
  const f = await fixture(t);
  const started = deferred();
  const gate = deferred();
  let downloads = 0;
  f.manager.sources.download = async () => {
    downloads++;
    started.resolve();
    await gate.promise;
    return { path: f.remotePath, source: f.source };
  };
  const first = preview(f);
  try {
    await started.promise;
    const secondCandidate = { ...f.candidate, repository: { ...f.repository, id: 999, url: 'https://github.com/other/skills' } };
    await assert.rejects(f.manager.call('skills.source.preview', { id: f.skill.id, candidate: secondCandidate }), { code: 'QUERY_BUSY' });
    assert.equal(downloads, 1);
  } finally { gate.resolve(); }
  const result = await first;
  assert.equal(result.source.repositoryId, f.repository.id);
  assert.equal(f.manager.store.all('source-previews').length, 1);
});

test('更新检查等待网络时解除来源关联，迟到结果不能复活关联或检查记录', async t => {
  const f = await fixture(t);
  const linked = await bind(f);
  const started = deferred();
  const gate = deferred();
  const inspect = f.manager.sources.inspect;
  f.manager.sources.inspect = async (...args) => { started.resolve(); await gate.promise; return inspect(...args); };
  const pending = f.manager.call('updates.check');
  try {
    await started.promise;
    await f.manager.call('skills.source.unbind', { id: f.skill.id });
    assert.equal(f.manager.store.get('source-bindings', f.skill.id), null);
    assert.equal(f.manager.store.get('updates', linked.sourceBinding.id), null);
  } finally { gate.resolve(); }
  assert.deepEqual(await pending, []);
  assert.equal(f.manager.store.get('source-bindings', f.skill.id), null);
  assert.equal(f.manager.store.get('updates', linked.sourceBinding.id), null);
  assert.equal(f.manager.skills()[0].versionStatus.status, 'unknown-source');
});

test('更新检查等待来源 A 时改绑来源 B，A 的迟到结果不能覆盖 B', async t => {
  const f = await fixture(t);
  await bind(f);
  const remoteB = path.join(path.dirname(f.remotePath), 'source-binding-b');
  await fs.cp(f.localPath, remoteB, { recursive: true });
  await fs.writeFile(path.join(remoteB, 'payload.txt'), '来源 B 的不同内容');
  const sourceB = { ...f.source, repositoryId: 889, fullName: 'fixture/source-b', url: 'https://github.com/fixture/source-b', commit: 'b'.repeat(40) };
  const candidateB = { ...f.candidate, repository: { ...f.repository, id: sourceB.repositoryId, fullName: sourceB.fullName, url: sourceB.url }, commit: sourceB.commit };
  const started = deferred();
  const gate = deferred();
  const inspect = f.manager.sources.inspect;
  f.manager.sources.inspect = async (...args) => { started.resolve(); await gate.promise; return inspect(...args); };
  f.manager.sources.download = async candidate => candidate.repository.id === sourceB.repositoryId
    ? { path: remoteB, source: sourceB } : { path: f.remotePath, source: f.source };
  const pending = f.manager.call('updates.check');
  let bindingB;
  let updateB;
  try {
    await started.promise;
    const comparison = await f.manager.call('skills.source.preview', { id: f.skill.id, candidate: candidateB });
    await f.manager.call('skills.source.bind', { previewId: comparison.id });
    bindingB = f.manager.store.get('source-bindings', f.skill.id);
    updateB = f.manager.store.get('updates', bindingB.id);
    assert.equal(bindingB.source.repositoryId, sourceB.repositoryId);
    assert.equal(updateB.status, 'different');
  } finally { gate.resolve(); }
  assert.deepEqual(await pending, []);
  assert.deepEqual(f.manager.store.get('source-bindings', f.skill.id), bindingB);
  assert.deepEqual(f.manager.store.get('updates', bindingB.id), updateB);
  assert.equal(f.manager.engine.deployments().length, 0);
});

test('取消登记后隐藏来源关联的检查结果，全量更新查询也不再访问该来源', async t => {
  const f = await fixture(t);
  const linked = await bind(f);
  const registered = f.manager.store.all('roots')[0];
  await f.manager.call('roots.remove', { id: registered.id });
  const bootstrap = await f.manager.call('bootstrap');
  assert.deepEqual(bootstrap.skills, []);
  assert.deepEqual(bootstrap.updates, []);
  assert.ok(f.manager.store.get('source-bindings', f.skill.id));
  assert.ok(f.manager.store.get('updates', linked.sourceBinding.id));
  f.manager.sources.inspect = async () => assert.fail('已取消登记的来源不得发起检查请求');
  f.manager.sources.download = async () => assert.fail('已取消登记的来源不得下载文件');
  assert.deepEqual(await f.manager.call('updates.check'), []);
  assert.ok(f.manager.store.get('source-bindings', f.skill.id));
  assert.equal(await fs.readFile(path.join(f.localPath, 'payload.txt'), 'utf8'), '原始附件');
});


test('批量检查后项等待时前项被改绑，批次结束不得覆盖已保存的新来源记录', async t => {
  const f = await fixture(t);
  const linked = await bind(f);
  const bindingA = linked.sourceBinding;
  const betaId = 'zz-skill-batch-beta';
  const betaPath = path.join(path.dirname(f.localPath), 'beta');
  await fs.cp(f.localPath, betaPath, { recursive: true });
  const sourceB = { ...f.source, repositoryId: 998, fullName: 'fixture/beta', url: 'https://github.com/fixture/beta', commit: 'b'.repeat(40) };
  const baseline = await buildManifest(betaPath);
  f.manager.store.put('skills', betaId, { ...f.skill, id: betaId, name: 'beta', physicalPath: betaPath,
    aliases: f.skill.aliases.map(alias => ({ ...alias, path: betaPath })), manifest: baseline, hash: baseline.hash });
  f.manager.store.put('source-bindings', betaId, { ...bindingA, id: `source:${betaId}`, skillId: betaId,
    physicalPath: betaPath, source: sourceB, baseline, baselineHash: baseline.hash });
  const started = deferred();
  const gate = deferred();
  f.manager.sources.inspect = async url => {
    const source = url === sourceB.url ? sourceB : f.source;
    return { repository: { id: source.repositoryId, url: source.url }, ref: source.ref, commit: source.commit,
      skills: [{ name: source === sourceB ? 'beta' : 'sample', path: source.subdir }] };
  };
  f.manager.sources.download = async candidate => {
    if (candidate.repository.id === sourceB.repositoryId) {
      started.resolve();
      await gate.promise;
      return { path: f.remotePath, source: sourceB };
    }
    return { path: f.remotePath, source: f.source };
  };
  const pending = f.manager.call('updates.check');
  let replacement;
  let replacementBinding;
  try {
    await started.promise;
    const alreadyChecked = f.manager.store.get('updates', bindingA.id);
    assert.equal(alreadyChecked.status, 'current');
    const sourceC = { ...f.source, repositoryId: 997, fullName: 'fixture/new-source', url: 'https://github.com/fixture/new-source', commit: 'c'.repeat(40) };
    replacementBinding = { ...bindingA, source: sourceC, baseline: null, baselineHash: null,
      linkedAt: new Date(Date.now() + 1).toISOString() };
    replacement = { ...alreadyChecked, source: sourceC, checkedSource: sourceC, status: 'different', baselineHash: null,
      checkedAt: replacementBinding.linkedAt, name: '用户刚确认的新来源' };
    f.manager.store.put('source-bindings', f.skill.id, replacementBinding);
    f.manager.store.put('updates', bindingA.id, replacement);
  } finally { gate.resolve(); }
  assert.equal((await pending).length, 2);
  assert.deepEqual(f.manager.store.get('source-bindings', f.skill.id), replacementBinding);
  assert.deepEqual(f.manager.store.get('updates', bindingA.id), replacement);
});
