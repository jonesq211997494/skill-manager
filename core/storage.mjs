import fs from 'node:fs/promises';
import path from 'node:path';

const GIB = 1024 ** 3;
const DEFAULT_LIMIT_GB = 5;
const DEFAULT_MAX_ENTRIES = 100000;
const CATEGORY_NAMES = [
  ['backups', '恢复快照'], ['revisions', '版本副本'], ['library', '集中技能库'],
  ['cache', '下载缓存'], ['staging', '暂存文件'],
];

// 只累计文件逻辑大小；不读取文件正文，也不检查账号、凭据或索引数据库。
export async function inspectStorage(dataDir, { limitGB = DEFAULT_LIMIT_GB, signal, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const requestedLimit = typeof limitGB === 'number' && Number.isFinite(limitGB) && limitGB > 0 ? limitGB * GIB : NaN;
  const limitBytes = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : DEFAULT_LIMIT_GB * GIB;
  const entryLimit = Number.isSafeInteger(maxEntries) && maxEntries >= 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
  const directory = path.resolve(dataDir);
  const categories = CATEGORY_NAMES.map(([id, name]) => ({ id, name, bytes: 0, files: 0, directories: 0, complete: true }));
  const issues = [];
  let inspectedEntries = 0;
  let stopped = false;

  function report(category, code, message, location) {
    category.complete = false;
    issues.push({ code, message, ...(location ? { path: location } : {}) });
  }

  function shouldStop(category, location, reserveEntry = false) {
    if (stopped) { category.complete = false; return true; }
    if (signal?.aborted) {
      stopped = true;
      report(category, 'STORAGE_CANCELLED', '存储统计已取消，当前结果仅包含已检查的文件。', location);
      return true;
    }
    if (reserveEntry && inspectedEntries >= entryLimit) {
      stopped = true;
      report(category, 'STORAGE_ENTRY_BUDGET', '存储统计达到条目上限，当前结果仅包含已检查的文件。', location);
      return true;
    }
    if (reserveEntry) inspectedEntries++;
    return false;
  }

  function accessFailure(category, failure, location) {
    const missing = failure?.code === 'ENOENT';
    report(category, missing ? 'STORAGE_ENTRY_CHANGED' : 'STORAGE_UNREADABLE',
      missing ? '统计期间目录或文件已变化，无法确认完整用量。' : '无法读取部分目录或文件的大小，请检查访问权限后重试。', location);
  }

  // 应用数据根本身为链接时也不向目标遍历，避免间接读取外部目录。
  if (!signal?.aborted && entryLimit > 0) {
    try {
      const root = await fs.lstat(directory);
      if (root.isSymbolicLink() || !root.isDirectory()) {
        for (const category of categories) category.complete = false;
        issues.push({ code: root.isSymbolicLink() ? 'STORAGE_LINK_SKIPPED' : 'STORAGE_NOT_DIRECTORY',
          message: root.isSymbolicLink() ? '应用数据目录是链接，未跟随读取目标内容。' : '应用数据路径不是普通目录，无法统计存储用量。', path: directory });
        stopped = true;
      }
    } catch (failure) {
      if (failure?.code !== 'ENOENT') {
        for (const category of categories) category.complete = false;
        issues.push({ code: 'STORAGE_UNREADABLE', message: '无法读取应用数据目录，请检查访问权限后重试。', path: directory });
        stopped = true;
      }
    }
  }

  for (const category of categories) {
    const categoryPath = path.join(directory, category.id);
    if (shouldStop(category, categoryPath, true)) continue;
    let root;
    try { root = await fs.lstat(categoryPath); }
    catch (failure) {
      // 尚未创建的类别目录属于正常的零用量。
      if (failure?.code !== 'ENOENT') accessFailure(category, failure, categoryPath);
      continue;
    }
    if (shouldStop(category, categoryPath)) continue;
    if (root.isSymbolicLink()) {
      report(category, 'STORAGE_LINK_SKIPPED', '已跳过符号链接或 Junction，未计入目标内容。', categoryPath);
      continue;
    }
    if (!root.isDirectory()) {
      report(category, 'STORAGE_NOT_DIRECTORY', '此存储类别路径不是普通目录，无法确认用量。', categoryPath);
      continue;
    }
    // 目录数包含类别根目录；存在但为空的目录计为 1 个目录、0 个文件。
    category.directories++;
    const pending = [categoryPath];
    while (pending.length && !shouldStop(category, pending.at(-1))) {
      const location = pending.pop();
      let handle;
      try {
        // 流式枚举避免一次性把大目录全部载入内存。
        handle = await fs.opendir(location, { bufferSize: 32 });
        while (!shouldStop(category, location)) {
          const entry = await handle.read();
          if (!entry) break;
          const entryPath = path.join(location, entry.name);
          if (shouldStop(category, entryPath, true)) break;
          let stat;
          try { stat = await fs.lstat(entryPath); }
          catch (failure) { accessFailure(category, failure, entryPath); continue; }
          if (shouldStop(category, entryPath)) break;
          if (stat.isSymbolicLink()) {
            report(category, 'STORAGE_LINK_SKIPPED', '已跳过符号链接或 Junction，未计入目标内容。', entryPath);
          } else if (stat.isDirectory()) {
            category.directories++;
            pending.push(entryPath);
          } else if (stat.isFile() && Number.isFinite(stat.size) && stat.size >= 0) {
            category.files++;
            category.bytes += stat.size;
          } else {
            report(category, 'STORAGE_UNSUPPORTED_ENTRY', '已跳过无法可靠统计大小的特殊文件。', entryPath);
          }
        }
      } catch (failure) {
        accessFailure(category, failure, location);
      } finally {
        if (handle) {
          try { await handle.close(); }
          catch { report(category, 'STORAGE_UNREADABLE', '关闭目录读取时发生错误，当前统计需要复查。', location); }
        }
      }
    }
  }

  if (signal?.aborted && !stopped) shouldStop(categories.at(-1), directory);
  const backupBytes = categories.find(category => category.id === 'backups').bytes;
  return {
    checkedAt: new Date().toISOString(), totalBytes: categories.reduce((sum, category) => sum + category.bytes, 0),
    backupBytes, limitBytes, overLimit: backupBytes > limitBytes,
    complete: categories.every(category => category.complete), categories, issues,
  };
}
