import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectStorage } from '../core/storage.mjs';

const GIB = 1024 ** 3;
async function fixture(t) {
  const location = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-storage-'));
  t.after(() => fs.rm(location, { recursive: true, force: true }));
  return location;
}
async function put(location, bytes) {
  await fs.mkdir(path.dirname(location), { recursive: true });
  await fs.writeFile(location, Buffer.alloc(bytes));
}
function category(result, id) { return result.categories.find(item => item.id === id); }

test('只统计五个应用目录的实际文件大小，忽略凭据、索引和其他目录', async t => {
  const root = await fixture(t);
  await put(path.join(root, 'backups', 'first.bin'), 15);
  await put(path.join(root, 'backups', 'nested', '.hidden'), 7);
  await put(path.join(root, 'revisions', 'SKILL.md'), 11);
  await put(path.join(root, 'library', 'library.bin'), 13);
  await put(path.join(root, 'cache', 'entry.bin'), 17);
  await put(path.join(root, 'staging', 'stage.bin'), 19);
  for (const ignored of ['credentials/github.enc', '.git/object', 'index.sqlite', 'other/private.bin']) await put(path.join(root, ignored), 100);
  const result = await inspectStorage(root);
  assert.equal(result.complete, true);
  assert.equal(result.totalBytes, 82);
  assert.equal(result.backupBytes, 22);
  assert.equal(result.limitBytes, 5 * GIB);
  assert.equal(result.overLimit, false);
  assert.equal(category(result, 'backups').files, 2);
  assert.equal(category(result, 'backups').directories, 2);
  assert.deepEqual(result.categories.map(item => item.id), ['backups', 'revisions', 'library', 'cache', 'staging']);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.deepEqual(result.issues, []);
  assert.equal((await fs.stat(path.join(root, 'credentials', 'github.enc'))).size, 100);
});

test('不存在的应用目录与类别目录按零用量正常返回', async t => {
  const root = await fixture(t);
  for (const location of [root, path.join(root, 'not-created')]) {
    const result = await inspectStorage(location);
    assert.equal(result.complete, true);
    assert.equal(result.totalBytes, 0);
    assert.equal(result.backupBytes, 0);
    assert.deepEqual(result.issues, []);
    assert.ok(result.categories.every(item => item.complete && !item.bytes && !item.files && !item.directories));
  }
});

test('容量提醒只比较恢复快照，不将缓存或其他目录计作快照', async t => {
  const root = await fixture(t);
  await put(path.join(root, 'backups', 'snapshot'), 10);
  await put(path.join(root, 'cache', 'large-cache'), 200);
  let result = await inspectStorage(root, { limitGB: 20 / GIB });
  assert.equal(result.totalBytes, 210);
  assert.equal(result.overLimit, false);
  result = await inspectStorage(root, { limitGB: 10 / GIB });
  assert.equal(result.overLimit, false);
  result = await inspectStorage(root, { limitGB: 9 / GIB });
  assert.equal(result.overLimit, true);
});

test('无效容量上限回退五 GiB，零字节文件仍计数', async t => {
  const root = await fixture(t);
  await put(path.join(root, 'backups', 'empty'), 0);
  for (const limitGB of [0, -1, NaN, Infinity, -Infinity, '2', null, Number.MAX_VALUE]) {
    const result = await inspectStorage(root, { limitGB });
    assert.equal(result.limitBytes, 5 * GIB);
    assert.equal(result.complete, true);
    assert.equal(result.overLimit, false);
    assert.equal(category(result, 'backups').files, 1);
  }
});

test('类别目录为 Junction 时不读取外部目标且明确标记统计不完整', async t => {
  const root = await fixture(t);
  const outside = path.join(root, 'outside');
  const data = path.join(root, 'data');
  await put(path.join(outside, 'private.bin'), 500);
  await fs.mkdir(data);
  await fs.symlink(outside, path.join(data, 'backups'), process.platform === 'win32' ? 'junction' : 'dir');
  await put(path.join(data, 'cache', 'normal'), 3);
  const result = await inspectStorage(data);
  assert.equal(result.complete, false);
  assert.equal(result.backupBytes, 0);
  assert.equal(result.totalBytes, 3);
  assert.equal(category(result, 'backups').complete, false);
  assert.equal(category(result, 'cache').complete, true);
  assert.ok(result.issues.some(item => item.code === 'STORAGE_LINK_SKIPPED'));
});

test('子目录循环 Junction 和指向外部的链接均跳过且保留已知大小', async t => {
  const root = await fixture(t);
  const backups = path.join(root, 'backups');
  const outside = path.join(root, 'outside');
  await put(path.join(backups, 'snapshot'), 12);
  await put(path.join(outside, 'private'), 400);
  await fs.symlink(backups, path.join(backups, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(outside, path.join(backups, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await inspectStorage(root, { limitGB: 10 / GIB });
  assert.equal(result.complete, false);
  assert.equal(result.backupBytes, 12);
  assert.equal(result.overLimit, true);
  assert.equal(category(result, 'backups').files, 1);
  assert.equal(category(result, 'backups').directories, 1);
  assert.equal(result.issues.filter(item => item.code === 'STORAGE_LINK_SKIPPED').length, 2);
});

test('应用数据根本身为链接时不向目标遍历', async t => {
  const root = await fixture(t);
  const actual = path.join(root, 'actual');
  await put(path.join(actual, 'backups', 'secret'), 100);
  const alias = path.join(root, 'alias');
  await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await inspectStorage(alias);
  assert.equal(result.complete, false);
  assert.equal(result.totalBytes, 0);
  assert.ok(result.categories.every(item => !item.complete));
  assert.deepEqual(result.issues.map(item => item.code), ['STORAGE_LINK_SKIPPED']);
});

test('全局预算限制遍历工作并保留分组部分结果，不将未检查目录标记正常', async t => {
  const root = await fixture(t);
  for (let index = 0; index < 10; index++) await put(path.join(root, 'backups', `file-${index}`), 5);
  await put(path.join(root, 'cache', 'cached'), 20);
  const result = await inspectStorage(root, { maxEntries: 3, limitGB: 1 / GIB });
  assert.equal(result.complete, false);
  assert.equal(result.backupBytes, 10);
  assert.equal(result.overLimit, true);
  assert.equal(category(result, 'backups').files, 2);
  assert.ok(result.categories.every(item => !item.complete));
  assert.deepEqual(result.issues.map(item => item.code), ['STORAGE_ENTRY_BUDGET']);
});

test('零预算立即停止，无效预算回退默认值', async t => {
  const root = await fixture(t);
  await put(path.join(root, 'backups', 'snapshot'), 10);
  const stopped = await inspectStorage(root, { maxEntries: 0 });
  assert.equal(stopped.complete, false);
  assert.equal(stopped.totalBytes, 0);
  assert.ok(stopped.categories.every(item => !item.complete));
  assert.equal(stopped.issues[0].code, 'STORAGE_ENTRY_BUDGET');
  for (const maxEntries of [-1, Infinity, NaN, 0.5]) {
    const result = await inspectStorage(root, { maxEntries });
    assert.equal(result.complete, true);
    assert.equal(result.backupBytes, 10);
  }
});

test('已取消的统计返回明确的不完整状态且不计算任何文件', async t => {
  const root = await fixture(t);
  await put(path.join(root, 'backups', 'snapshot'), 10);
  const controller = new AbortController();
  controller.abort();
  const result = await inspectStorage(root, { signal: controller.signal });
  assert.equal(result.complete, false);
  assert.equal(result.totalBytes, 0);
  assert.equal(result.overLimit, false);
  assert.ok(result.categories.every(item => !item.complete));
  assert.deepEqual(result.issues.map(item => item.code), ['STORAGE_CANCELLED']);
});

test('统计进行中取消可以结束流式枚举，并保留不完整提示', async t => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 80 }, (_, index) => put(path.join(root, 'backups', `snapshot-${index}`), 1)));
  const controller = new AbortController();
  const pending = inspectStorage(root, { signal: controller.signal });
  setImmediate(() => controller.abort());
  const result = await pending;
  assert.equal(result.complete, false);
  assert.ok(result.totalBytes < 80);
  assert.ok(result.issues.some(item => item.code === 'STORAGE_CANCELLED'));
});

test('类别路径被普通文件占用时明确报错，其他类别继续统计', async t => {
  const root = await fixture(t);
  await put(path.join(root, 'backups'), 100);
  await put(path.join(root, 'cache', 'cache'), 9);
  const result = await inspectStorage(root);
  assert.equal(result.complete, false);
  assert.equal(result.backupBytes, 0);
  assert.equal(result.totalBytes, 9);
  assert.equal(category(result, 'cache').complete, true);
  assert.ok(result.issues.some(item => item.code === 'STORAGE_NOT_DIRECTORY'));
});


test('部分目录无访问权限时保留其他类别结果，并明确标记无法确认完整用量', async t => {
  const root = await fixture(t);
  const denied = path.join(root, 'backups');
  await put(path.join(denied, 'snapshot'), 100);
  await put(path.join(root, 'cache', 'normal'), 7);
  const original = fs.opendir;
  t.mock.method(fs, 'opendir', async (location, options) => {
    if (location === denied) throw Object.assign(new Error('测试模拟权限错误'), { code: 'EACCES' });
    return original(location, options);
  });
  const result = await inspectStorage(root);
  assert.equal(result.complete, false);
  assert.equal(result.totalBytes, 7);
  assert.equal(result.backupBytes, 0);
  assert.equal(category(result, 'backups').complete, false);
  assert.equal(category(result, 'cache').complete, true);
  assert.deepEqual(result.issues.map(item => item.code), ['STORAGE_UNREADABLE']);
  assert.equal(result.issues[0].message.includes('测试模拟权限错误'), false);
});

test('统计只查询元数据，不调用正文读取函数', async t => {
  const root = await fixture(t);
  await put(path.join(root, 'backups', 'snapshot'), 19);
  t.mock.method(fs, 'readFile', () => assert.fail('存储统计不得读取文件正文'));
  const result = await inspectStorage(root);
  assert.equal(result.complete, true);
  assert.equal(result.backupBytes, 19);
});
