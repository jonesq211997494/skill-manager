import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ManagerService } from '../core/service.mjs';

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'skill-manager-ipc-')));
  const identity = await fs.stat(directory, { bigint: true });
  const calls = [];
  const options = {
    dataDir: path.join(directory, 'data'), home: path.join(directory, 'home'),
    onSettings: async settings => calls.push({ ...settings }),
    fetchImpl: () => { throw new Error('参数测试禁止真实网络'); },
  };
  let manager = new ManagerService(options);
  const settings = { theme: 'light', fontSize: 14, libraryPath: path.join(directory, 'library'), proxy: '', backupDays: 30, backupMinimum: 3, backupLimitGB: 5 };
  manager.store.put('settings', 'main', settings);
  manager.store.put('skills', 'skill', { id: 'skill', name: 'fixture' });
  manager.store.put('metadata', 'skill', { alias: '原始别名', tags: ['原始标签'], favorite: true });
  t.after(async () => {
    await manager.close();
    const resolved = await fs.realpath(directory);
    assert.equal(resolved, directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('skill-manager-ipc-'));
    const current = await fs.stat(resolved, { bigint: true });
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { get manager() { return manager; }, settings, calls, directory,
    async restart() { await manager.close(); manager = new ManagerService(options); return manager; } };
}

test('服务入口拒绝畸形整理请求且元数据不发生部分写入', async t => {
  const { manager } = await fixture(t);
  const before = manager.store.get('metadata', 'skill');
  for (const patch of [{ alias: '新别名', tags: [123] }, { alias: 'x'.repeat(201) }, { favorite: 'false' }, { pinned: 1 }, { alias: '新别名', surprise: true }]) {
    await assert.rejects(manager.call('skills.organize', { id: 'skill', ...patch }), { code: 'INVALID_ARGUMENT' });
    assert.deepEqual(manager.store.get('metadata', 'skill'), before);
  }
  await assert.rejects(manager.call('bootstrap', []), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(manager.call('not.registered', {}), { code: 'UNKNOWN_METHOD' });
});

test('无效设置在网络配置回调前全部拒绝，有效数值按 number 持久化', async t => {
  const { manager, settings, calls } = await fixture(t);
  for (const patch of [{ theme: 'dark', backupDays: '30' }, { theme: 'dark', backupMinimum: NaN }, { theme: 'dark', backupLimitGB: Infinity }, { theme: 'dark', fontSize: false }, { theme: 'dark', libraryPath: '\0bad' }]) {
    await assert.rejects(manager.call('settings.save', patch), { code: 'INVALID_ARGUMENT' });
    assert.deepEqual(manager.store.get('settings', 'main'), settings);
    assert.equal(calls.length, 0);
  }
  const result = await manager.call('settings.save', { theme: 'dark', backupDays: 60, backupMinimum: 4, backupLimitGB: 0.5, projects: [] });
  const saved = manager.store.get('settings', 'main');
  assert.deepEqual(saved, result);
  assert.equal(calls.length, 1);
  assert.equal('projects' in saved, false);
  for (const key of ['backupDays', 'backupMinimum', 'backupLimitGB']) assert.equal(typeof saved[key], 'number');
});

test('参数校验先于计划写入、目录读取和在线认证', async t => {
  const { manager } = await fixture(t);
  for (const [method, args] of [
    ['operations.plan', { kind: 'remove', deploymentId: 'skill', force: 'true' }],
    ['roots.add', { path: false }],
    ['projects.add', { path: 'relative' }],
    ['sources.search', { query: 'skills', page: NaN }],
    ['sources.preview', { candidate: {} }],
  ]) await assert.rejects(manager.call(method, args), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(manager.store.all('plans'), []);
  assert.deepEqual(manager.store.all('roots'), []);
  assert.deepEqual(manager.store.all('projects'), []);
});


test('旧库数字字符串在保存其他偏好时统一转为 number，重启后仍保持数值类型', async t => {
  const f = await fixture(t);
  f.manager.store.put('settings', 'main', { ...f.settings, fontSize: '16', backupDays: '60', backupMinimum: '4', backupLimitGB: '0.5' });
  const saved = await f.manager.call('settings.save', { theme: 'dark' });
  assert.deepEqual(saved, { ...f.settings, theme: 'dark', fontSize: 16, backupDays: 60, backupMinimum: 4, backupLimitGB: 0.5 });
  await f.restart();
  assert.deepEqual(f.manager.store.get('settings', 'main'), saved);
  for (const key of ['fontSize', 'backupDays', 'backupMinimum', 'backupLimitGB']) assert.equal(typeof f.manager.store.get('settings', 'main')[key], 'number');
});

test('旧库中不可转换的备份值不会导致部分保存', async t => {
  const f = await fixture(t);
  const previous = { ...f.settings, backupDays: 'not-a-number' };
  f.manager.store.put('settings', 'main', previous);
  await assert.rejects(f.manager.call('settings.save', { theme: 'dark' }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(f.manager.store.get('settings', 'main'), previous);
  assert.equal(f.calls.length, 0);
});
