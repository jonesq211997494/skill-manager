import fs from 'node:fs/promises';
import path from 'node:path';
import { inside } from './operations.mjs';
import { fail } from './errors.mjs';

export async function resolveAllowedOpenPath(requested, roots) {
  const logical = path.resolve(requested);
  const physical = await fs.realpath(logical);
  const stat = await fs.stat(physical);
  if (!stat.isDirectory() && path.extname(physical).toLowerCase() !== '.md') {
    fail('INVALID_PATH', '只允许打开目录和 Markdown 文件。');
  }
  for (const root of roots) {
    try {
      const physicalRoot = await fs.realpath(root);
      // 详情页显示真实位置，登记为 Junction 的根也须允许该位置；最终边界仍以真实路径为准。
      if ((inside(root, logical) || inside(physicalRoot, logical)) && inside(physicalRoot, physical)) return physical;
    } catch (error) {
      if (!['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code)) throw error;
    }
  }
  fail('INVALID_PATH', '路径不在已登记目录内，或链接指向目录范围之外。');
}
