import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail } from './errors.mjs';

export const SCHEMA_VERSION = 1;
const identityKeys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];

function fileState(filename) {
  try {
    const stat = fs.statSync(filename, {bigint:true});
    return Object.fromEntries(identityKeys.map(key => [key, stat[key]]));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function assertUnchanged(files, before) {
  for (let index = 0; index < files.length; index++) {
    const after = fileState(files[index]), previous = before[index];
    if (!!after !== !!previous || (after && identityKeys.some(key => after[key] !== previous[key]))) {
      fail('DATABASE_CHANGED', '数据库在启动检查期间发生变化，已停止写入。请关闭其他使用该数据库的程序后重试。');
    }
  }
}
function removeProbe(directory, temporaryRoot, identity) {
  // 只清理本次创建、边界和目录实体均未变化的临时副本。
  const resolved = fs.realpathSync(directory), current = fs.statSync(directory, {bigint:true});
  if (resolved !== directory || path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('skillspace-db-probe-') || current.dev !== identity.dev || current.ino !== identity.ino) {
    fail('DATABASE_PROBE_CHANGED', '数据库检查的临时目录已变化，已保留现场且停止写入。');
  }
  fs.rmSync(resolved, {recursive:true, force:true});
}

// 版本 1 结构保持不变。未来增加迁移时须先实现一致备份与逐级事务迁移。
export function checkDatabaseVersion(filename) {
  if (!fs.existsSync(filename)) return false;
  // SQLite 的 readOnly 连接仍可能创建或修改 WAL/SHM，因此只连接临时副本。
  // 必须一并读取已提交的 WAL，不能用 immutable 忽略尚未 checkpoint 的版本变化。
  const files = [filename, `${filename}-wal`], before = files.map(fileState);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'skillspace-db-probe-')));
  const identity = fs.statSync(directory, {bigint:true});
  const snapshot = path.join(directory, 'index.sqlite');
  let probe;
  try {
    try {
      fs.copyFileSync(filename, snapshot, fs.constants.COPYFILE_EXCL);
      if (before[1]) fs.copyFileSync(files[1], `${snapshot}-wal`, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      assertUnchanged(files, before);
      throw error;
    }
    assertUnchanged(files, before);
    probe = new DatabaseSync(snapshot, {readOnly:true});
    if (!probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get()) {
      fail('DATABASE_VERSION_INVALID', '数据库缺少格式版本，已停止写入。请保留原库并使用迁移预览。');
    }
    const rows = probe.prepare('SELECT version FROM schema_version').all();
    if (rows.some(row => Number.isInteger(row.version) && row.version > SCHEMA_VERSION)) {
      fail('DATABASE_TOO_NEW', '数据库由更高版本程序创建，已停止写入。请升级程序后再打开。');
    }
    if (rows.length !== 1 || rows[0].version !== SCHEMA_VERSION) {
      fail('DATABASE_VERSION_INVALID', '数据库格式版本不受支持或记录有歧义，已停止写入。');
    }
    // 使用迭代器检查，避免将全部正文同时读入内存。
    try {
      for (const row of probe.prepare('SELECT data FROM records').iterate()) JSON.parse(row.data);
    } catch {
      fail('DATABASE_CONTENT_INVALID', '数据库记录无法完整读取，已停止写入。请保留原库以便恢复。');
    }
    assertUnchanged(files, before);
    return true;
  } finally {
    try { probe?.close(); } finally { removeProbe(directory, temporaryRoot, identity); }
  }
}
