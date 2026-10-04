import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagerService } from '../core/service.mjs';
import { Store } from '../core/store.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, options = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'skill-manager-lifecycle-')));
  const identity = await fs.stat(root, { bigint: true });
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(home);
  const manager = new ManagerService({ dataDir, home,
    fetchImpl: () => { throw new Error('生命周期测试禁止真实网络'); }, ...options });
  manager.store.put('settings', 'main', { theme: 'light', fontSize: 14, libraryPath: path.join(dataDir, 'library'), proxy: '', backupDays: 30, backupMinimum: 3, backupLimitGB: 5 });
  manager.store.put('state', 'initialized', true);
  let closes = 0;
  const closeStore = manager.store.close.bind(manager.store);
  manager.store.close = () => { closes++; closeStore(); };
  t.after(async () => {
    await manager.close();
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith('skill-manager-lifecycle-'));
    const current = await fs.stat(root, { bigint: true });
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { manager, root, home, dataDir, closes: () => closes };
}

test('关闭使用同一 Promise，拒绝新调用，并等待设置回写后再关库', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { onSettings: async () => { started.resolve(); await release.promise; } });
  assert.equal(typeof f.manager.shutdown, 'function');
  const save = f.manager.call('settings.save', { theme: 'dark' });
  await started.promise;
  const shutdown = f.manager.shutdown();
  assert.equal(f.manager.shutdown(), shutdown);
  assert.equal(f.manager.close(), shutdown);
  assert.equal(f.closes(), 0);
  assert.equal(f.manager.lifecycle.closing, true);
  await assert.rejects(f.manager.call('settings.save', { theme: 'light' }), { code: 'SERVICE_CLOSING' });
  release.resolve();
  await save;
  await shutdown;
  assert.equal(f.closes(), 1);
  const reopened = new Store(f.dataDir);
  try { assert.equal(reopened.get('settings', 'main').theme, 'dark'); }
  finally { reopened.close(); }
});

test('查询取消后的清理和认证退出都完成后才关闭数据库', async t => {
  const queryStarted = deferred(), queryCancelled = deferred(), queryRelease = deferred();
  const loginStarted = deferred(), loginCancelled = deferred(), loginRelease = deferred();
  let cancellations = 0;
  const auth = {
    loginToken: async () => {
      loginStarted.resolve(); await loginCancelled.promise; await loginRelease.promise;
      throw Object.assign(new Error('测试登录已取消'), { code: 'AUTH_CANCELLED' });
    },
    cancelLogin: () => { cancellations++; loginCancelled.resolve(); },
  };
  const f = await fixture(t, { auth });
  assert.equal(typeof f.manager.shutdown, 'function');
  f.manager.performScan = async signal => {
    queryStarted.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    queryCancelled.resolve(); await queryRelease.promise;
    f.manager.store.put('state', 'query-cleanup', true);
    throw Object.assign(new Error('测试查询已取消'), { code: 'CANCELLED' });
  };
  const query = assert.rejects(f.manager.call('scan'), { code: 'CANCELLED' });
  const login = assert.rejects(f.manager.call('github.loginToken', { token: 'fixture-token' }), { code: 'AUTH_CANCELLED' });
  await Promise.all([queryStarted.promise, loginStarted.promise]);
  const shutdown = f.manager.shutdown();
  await Promise.all([queryCancelled.promise, loginCancelled.promise]);
  assert.equal(f.closes(), 0);
  assert.equal(cancellations, 1);
  queryRelease.resolve();
  await query;
  assert.equal(f.manager.store.get('state', 'query-cleanup'), true);
  assert.equal(f.closes(), 0);
  loginRelease.resolve();
  await login;
  await shutdown;
  assert.equal(f.closes(), 1);
});

test('已接受调用失败不会提前关库或阻止其他调用完成', async t => {
  const release = deferred();
  let manager;
  const f = await fixture(t, {
    chooseDirectory: async () => { await release.promise; throw new Error('预期失败'); },
    chooseFile: async () => { await release.promise; manager.store.put('state', 'late-write', true); return true; },
  });
  manager = f.manager;
  assert.equal(typeof f.manager.shutdown, 'function');
  const rejected = assert.rejects(f.manager.call('dialog.directory'), /预期失败/);
  const completed = f.manager.call('dialog.file');
  const shutdown = f.manager.shutdown();
  assert.equal(f.closes(), 0);
  release.resolve();
  await Promise.all([rejected, completed, shutdown]);
  assert.equal(f.closes(), 1);
  const reopened = new Store(f.dataDir);
  try { assert.equal(reopened.get('state', 'late-write'), true); }
  finally { reopened.close(); }
});

test('直接进入引擎的排队任务也必须排空，close 在忙时返回 shutdown', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t);
  assert.equal(typeof f.manager.shutdown, 'function');
  const order = [];
  f.manager.engine.executeLocked = async id => {
    if (id === 'first') { started.resolve(); await release.promise; }
    f.manager.store.put('state', id, true); order.push(id); return id;
  };
  const first = f.manager.engine.execute('first', 'fixture');
  const second = f.manager.engine.execute('second', 'fixture');
  await started.promise;
  const shutdown = f.manager.close();
  assert.equal(shutdown, f.manager.shutdown());
  assert.equal(f.closes(), 0);
  release.resolve();
  await Promise.all([first, second, shutdown]);
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(f.closes(), 1);
});

test('空闲 close 同步关闭数据库，重复关闭不会再次调用 SQLite close', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.manager.shutdown, 'function');
  const closed = f.manager.close();
  assert.equal(f.closes(), 1);
  assert.equal(f.manager.shutdown(), closed);
  assert.equal(f.manager.close(), closed);
  await assert.rejects(f.manager.call('operations.history'), { code: 'SERVICE_CLOSING' });
  assert.equal(f.closes(), 1);
});

test('真实文件提交及服务登记在退出前完成，重开后的恢复无需回滚已提交结果', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.manager.shutdown, 'function');
  const source = path.join(f.root, 'source-skill');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: shutdown-skill\ndescription: 关闭回归夹具\n---\n已提交内容\n');
  const plan = await f.manager.call('operations.plan', { kind: 'install', name: 'shutdown-skill', sourcePath: source, targets: [{ tool: 'codex', scope: 'user' }] });
  assert.deepEqual(plan.blockers, []);
  const committed = deferred(), release = deferred();
  const applyStep = f.manager.engine.applyStep.bind(f.manager.engine);
  f.manager.engine.applyStep = async (operation, step) => {
    await applyStep(operation, step); committed.resolve(); await release.promise;
  };
  let scans = 0;
  f.manager.performScan = async () => { scans++; throw new Error('退出期间不应开始自动扫描'); };
  const execution = f.manager.call('operations.execute', { planId: plan.id, digest: plan.digest });
  await committed.promise;
  const shutdown = f.manager.shutdown();
  assert.equal(f.closes(), 0);
  release.resolve();
  const result = await execution;
  await shutdown;
  assert.equal(result.status, 'completed');
  assert.equal(scans, 0);
  const reopened = new ManagerService({ dataDir: f.dataDir, home: f.home });
  try {
    assert.equal(reopened.store.get('operations', plan.id).status, 'completed');
    assert.equal(reopened.store.all('deployments').length, 1);
    assert.ok(reopened.store.all('roots').some(root => root.path === path.dirname(plan.steps[0].targetPath)));
    assert.deepEqual(await reopened.engine.recover(), []);
    assert.match(await fs.readFile(path.join(plan.steps[0].targetPath, 'SKILL.md'), 'utf8'), /已提交内容/);
  } finally { await reopened.close(); }
});

test('受理后尚未开始的查询遇到关闭时直接取消，不进入查询正文', async t => {
  const f = await fixture(t);
  let entered = false;
  f.manager.performScan = async () => { entered = true; return {}; };
  const query = assert.rejects(f.manager.call('scan'), { code: 'CANCELLED' });
  const shutdown = f.manager.shutdown();
  await Promise.all([query, shutdown]);
  assert.equal(entered, false);
  assert.equal(f.manager.jobs.size, 0);
  assert.equal(f.manager.queryPromises.size, 0);
  assert.equal(f.closes(), 1);
});

test('启动恢复中的回写也属于受控关闭等待范围', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t);
  f.manager.engine.recover = async () => {
    started.resolve(); await release.promise;
    f.manager.store.put('state', 'recovery-finished', true); return [];
  };
  const initialization = f.manager.initialize();
  await started.promise;
  const shutdown = f.manager.shutdown();
  assert.equal(f.closes(), 0);
  release.resolve();
  await initialization;
  await shutdown;
  assert.equal(f.closes(), 1);
  const reopened = new Store(f.dataDir);
  try { assert.equal(reopened.get('state', 'recovery-finished'), true); }
  finally { reopened.close(); }
});

test('关闭发生于认证检查等待中时，不再创建新的在线请求', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { auth: {
    getCredential: async () => { started.resolve(); await release.promise; return { token: 'fixture-token', cacheKey: 'fixture' }; },
  } });
  let requests = 0;
  f.manager.sources.search = async () => { requests++; return {}; };
  const request = assert.rejects(f.manager.call('sources.search', { query: 'fixture' }), { code: 'SERVICE_CLOSING' });
  await started.promise;
  const shutdown = f.manager.shutdown();
  release.resolve();
  await Promise.all([request, shutdown]);
  assert.equal(requests, 0);
  assert.equal(f.closes(), 1);
});

for (const phase of ['snapshot', 'staging', 'switch', 'metadata']) {
  test(`实际更新在 ${phase} 阶段正常退出，完成提交后才关库并可重开恢复`, async t => {
    const f = await fixture(t);
    const source = path.join(f.root, 'phase-source');
    await fs.mkdir(source);
    const before = '---\nname: phase-skill\ndescription: 阶段关闭夹具\n---\n旧版正文\n';
    const after = before.replace('旧版正文', '新版正文');
    await fs.writeFile(path.join(source, 'SKILL.md'), before);
    f.manager.performScan = async () => ({});
    const installation = await f.manager.call('operations.plan', { kind: 'install', name: 'phase-skill', sourcePath: source, targets: [{ tool: 'codex', scope: 'user' }] });
    await f.manager.call('operations.execute', { planId: installation.id, digest: installation.digest });
    const deployment = f.manager.store.all('deployments')[0];
    await fs.writeFile(path.join(source, 'SKILL.md'), after);
    const plan = await f.manager.call('operations.plan', { kind: 'update', deploymentId: deployment.id, sourcePath: source });
    assert.deepEqual(plan.blockers, []);
    let shutdown, blocked;
    const stopAtPhase = () => {
      if (shutdown) return;
      shutdown = f.manager.shutdown();
      assert.equal(f.closes(), 0);
      assert.equal(f.manager.lifecycle.closing, true);
      blocked = assert.rejects(f.manager.call('operations.history'), { code: 'SERVICE_CLOSING' });
    };
    const originalPut = f.manager.store.put.bind(f.manager.store);
    const originalCopy = fs.cp;
    const originalRename = fs.rename;
    const originalMetadata = f.manager.engine.commitMetadata.bind(f.manager.engine);
    f.manager.store.put = (collection, id, record) => {
      const saved = originalPut(collection, id, record);
      if (phase === 'snapshot' && collection === 'operations' && id === plan.id && record.steps[0].status === 'snapshotted') stopAtPhase();
      return saved;
    };
    // 只在当前夹具的暂存或切换路径上触发退出，其他文件调用保持原样。
    fs.cp = async (from, to, options) => {
      const result = await originalCopy(from, to, options);
      if (phase === 'staging' && path.dirname(to) === path.dirname(deployment.targetPath) && path.basename(to).startsWith('.skill-manager-stage-')) stopAtPhase();
      return result;
    };
    fs.rename = async (from, to) => {
      const result = await originalRename(from, to);
      if (phase === 'switch' && from === deployment.targetPath) {
        await assert.rejects(fs.stat(deployment.targetPath), { code: 'ENOENT' });
        stopAtPhase();
      }
      return result;
    };
    f.manager.engine.commitMetadata = (operation, step) => {
      originalMetadata(operation, step);
      if (phase === 'metadata') stopAtPhase();
    };
    let result;
    try {
      result = await f.manager.call('operations.execute', { planId: plan.id, digest: plan.digest });
      assert.ok(shutdown, '必须命中指定的实际文件阶段');
      await Promise.all([shutdown, blocked]);
    } finally {
      fs.cp = originalCopy;
      fs.rename = originalRename;
    }
    assert.equal(f.closes(), 1);
    assert.equal(result.status, 'completed');
    assert.equal(result.indexRefresh.status, 'skipped');
    assert.equal(result.indexRefresh.pending, true);
    const reopened = new ManagerService({ dataDir: f.dataDir, home: f.home });
    try {
      const record = reopened.store.get('operations', plan.id);
      assert.equal(record.status, 'completed');
      assert.equal(record.indexRefresh.pending, true);
      assert.equal(record.steps[0].status, 'completed');
      assert.equal(await fs.readFile(path.join(deployment.targetPath, 'SKILL.md'), 'utf8'), after);
      assert.equal(await fs.readFile(path.join(record.steps[0].snapshotPath, 'SKILL.md'), 'utf8'), before);
      assert.equal(reopened.store.get('deployments', deployment.id).baselineHash, plan.steps[0].afterHash);
      assert.deepEqual(await reopened.engine.recover(), []);
      assert.equal(await fs.readFile(path.join(deployment.targetPath, 'SKILL.md'), 'utf8'), after);
    } finally { await reopened.close(); }
  });
}
