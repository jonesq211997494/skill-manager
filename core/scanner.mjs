import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';

const DEFAULT_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const relativeName = value => value.split(path.sep).join('/');
const issue = (code, message, location, extra = {}) => ({ code, message, path: location, ...extra });
const isExcludedDirectory = name => name === '.git' || name.startsWith('.skill-manager-stage-') || name.startsWith('.skill-manager-retired-');
const isWithin = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

// 使用卷与文件标识识别实体；无法获得标识时保留实际路径的大小写。
async function inspectDirectory(location) {
  const [entry, physicalPath] = await Promise.all([fs.lstat(location), fs.realpath(location)]);
  const stat = await fs.stat(physicalPath, { bigint: true });
  if (!stat.isDirectory()) throw Object.assign(new Error('该路径不是目录'), { code: 'ENOTDIR' });
  const identity = stat.ino !== 0n
    ? `file:${stat.dev.toString()}:${stat.ino.toString()}`
    : `path:${physicalPath}`;
  return { identity, physicalPath, link: entry.isSymbolicLink() };
}

function errorIssue(error, location) {
  if (error.code === 'ENOENT') return issue('PATH_MISSING', '路径不存在或链接目标已缺失', location);
  if (error.code === 'ELOOP') return issue('LINK_CYCLE', '链接存在循环，已停止遍历此入口', location);
  if (error.code === 'ENOTDIR') return issue('NOT_DIRECTORY', '扫描根不是目录', location);
  return issue('PATH_UNREADABLE', '无法读取路径，请检查访问权限或文件占用', location, { systemCode: error.code ?? 'UNKNOWN' });
}

function parseSkill(raw, location) {
  const problems = [];
  let metadata = {};
  let body = raw;
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (normalized.startsWith('---\n')) {
    const closing = /^---\s*$/gm;
    closing.lastIndex = 4;
    const end = closing.exec(normalized);
    if (!end) {
      problems.push(issue('METADATA_ERROR', 'YAML 元数据缺少结束分隔符', location));
    } else {
      body = normalized.slice(end.index + end[0].length).replace(/^\n/, '');
      try {
        const document = parseDocument(normalized.slice(4, end.index), { uniqueKeys: true });
        if (document.errors.length) throw new Error('YAML 语法无效');
        const parsed = document.toJS({ maxAliasCount: 50 });
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('元数据必须为映射');
        metadata = parsed;
      } catch {
        problems.push(issue('METADATA_ERROR', 'YAML 元数据无法解析，原文已保留', location));
      }
    }
  } else {
    problems.push(issue('METADATA_ERROR', '缺少 YAML 元数据，已按文件夹名称保留候选', location));
  }
  for (const field of ['name', 'description']) {
    if (typeof metadata[field] !== 'string' || !metadata[field].trim()) {
      problems.push(issue('METADATA_FIELD', `元数据 ${field} 缺失或不是非空文本`, location));
    }
  }
  return {
    name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : path.basename(path.dirname(location)),
    description: typeof metadata.description === 'string' ? metadata.description : '',
    metadata, body, issues: problems,
  };
}

// 清单覆盖所有普通文件，包括隐藏文件与二进制附件，仅固定排除 .git。
export async function buildManifest(directory, options = {}) {
  const {
    signal, onProgress, maxDepth = 64, maxEntries = 50000,
    maxFileBytes = DEFAULT_FILE_BYTES, maxTotalBytes = DEFAULT_TOTAL_BYTES,
  } = options;
  const manifest = { version: 1, hash: null, complete: true, files: [], issues: [], bytes: 0, exclusions: ['.git'] };
  let physicalRoot;
  try { physicalRoot = (await inspectDirectory(directory)).physicalPath; }
  catch (error) { manifest.complete = false; manifest.issues.push(errorIssue(error, directory)); return manifest; }
  let entries = 0;
  let stopped = false;
  const record = problem => { manifest.complete = false; manifest.issues.push(problem); };
  const checkStop = location => {
    if (stopped) return true;
    if (signal?.aborted) {
      stopped = true;
      record(issue('SCAN_CANCELLED', '检查已取消，清单不完整', location));
    }
    return stopped;
  };
  async function hashFile(location, stat) {
    if (stat.size > maxFileBytes) {
      record(issue('FILE_BUDGET', '文件超过单文件读取预算，未完成比较', location, { size: stat.size, limit: maxFileBytes }));
      return null;
    }
    if (manifest.bytes + stat.size > maxTotalBytes) {
      record(issue('BYTE_BUDGET', '包内容超过总读取预算，未完成比较', location, { limit: maxTotalBytes }));
      return null;
    }
    const hash = createHash('sha256');
    let fileBytes = 0;
    let handle;
    try {
      // 打开后先核对实体再读内容，避免检查期间入口被替换为包外链接。
      handle = await fs.open(location, 'r');
      const opened = await handle.stat();
      const currentPath = await fs.realpath(location);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || !isWithin(physicalRoot, currentPath)) {
        record(issue('FILE_CHANGED', '文件入口在检查期间发生变化，未读取内容', location));
        return null;
      }
      for await (const chunk of handle.createReadStream({ highWaterMark: 256 * 1024, autoClose: false })) {
        if (checkStop(location)) return null;
        fileBytes += chunk.length;
        manifest.bytes += chunk.length;
        if (manifest.bytes > maxTotalBytes || fileBytes > maxFileBytes) {
          record(issue('BYTE_BUDGET', '读取期间文件增长并超过预算，未完成比较', location));
          return null;
        }
        hash.update(chunk);
      }
      const after = await handle.stat();
      const pathAfter = await fs.lstat(location);
      if (!pathAfter.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino || pathAfter.ino !== stat.ino || fileBytes !== stat.size) {
        record(issue('FILE_CHANGED', '文件在检查期间发生变化，请重新检查', location));
        return null;
      }
      return hash.digest('hex');
    } catch (error) { record(errorIssue(error, location)); return null; }
    finally { await handle?.close().catch(() => {}); }
  }
  async function walk(location, relative, depth) {
    if (checkStop(location)) return;
    if (depth > maxDepth) { record(issue('DEPTH_BUDGET', '包目录超过最大检查深度', location, { limit: maxDepth })); return; }
    let children;
    try {
      const currentPath = await fs.realpath(location);
      if (!isWithin(physicalRoot, currentPath)) { record(issue('EXTERNAL_LINK', '目录入口在检查期间改为包外链接，未跟随读取', location)); return; }
      children = await fs.readdir(currentPath, { withFileTypes: true });
    }
    catch (error) { record(errorIssue(error, location)); return; }
    children.sort((a, b) => compareText(a.name, b.name));
    for (const child of children) {
      if (child.name === '.git') continue;
      const target = path.join(location, child.name);
      if (checkStop(target)) break;
      if (++entries > maxEntries) {
        stopped = true;
        record(issue('ENTRY_BUDGET', '包条目数超过检查预算', target, { limit: maxEntries }));
        break;
      }
      const name = relativeName(path.join(relative, child.name));
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) {
          const link = { path: name, type: 'link', size: stat.size, target: await fs.readlink(target), targetType: 'unknown' };
          manifest.files.push(link);
          try {
            const resolved = await fs.realpath(target);
            const linkedStat = await fs.stat(resolved);
            link.targetType = linkedStat.isDirectory() ? 'directory' : linkedStat.isFile() ? 'file' : 'other';
            link.external = !isWithin(physicalRoot, resolved);
            if (link.external) record(issue('EXTERNAL_LINK', '包内链接指向包外，未跟随读取，比较不完整', target));
            else if (path.relative(physicalRoot, resolved).split(path.sep).includes('.git')) record(issue('EXCLUDED_LINK', '包内链接指向排除目录，比较不完整', target));
          } catch (error) { record(errorIssue(error, target)); }
        } else if (stat.isDirectory()) {
          manifest.files.push({ path: name, type: 'directory', size: 0 });
          await walk(target, path.join(relative, child.name), depth + 1);
        } else if (stat.isFile()) {
          manifest.files.push({ path: name, type: 'file', size: stat.size, hash: await hashFile(target, stat) });
        } else {
          manifest.files.push({ path: name, type: 'other', size: stat.size });
          record(issue('UNSUPPORTED_FILE', '包内存在无法完整比较的特殊文件', target));
        }
      } catch (error) { record(errorIssue(error, target)); }
      onProgress?.({ phase: 'hash', path: directory, files: manifest.files.length, bytes: manifest.bytes });
    }
  }
  await walk(physicalRoot, '', 0);
  manifest.files.sort((a, b) => compareText(a.path, b.path));
  if (manifest.complete) {
    manifest.hash = digest(JSON.stringify({
      version: manifest.version, exclusions: manifest.exclusions,
      files: manifest.files.map(file => [file.path, file.type, file.size, file.hash ?? null, file.target ?? null, file.targetType ?? null]),
    }));
  }
  return manifest;
}

export async function scanRoots(roots, options = {}) {
  const {
    signal, onProgress, maxDepth = 12, maxEntries = 50000,
    maxFileBytes = 4 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024,
    hashPackages = false, manifestOptions = {}, excludePaths = [],
  } = options;
  const skills = new Map();
  const cache = new Map();
  const issues = [];
  const rootReports = [];
  const exclusions = excludePaths.map(item => path.resolve(item));
  let entries = 0;
  let bytes = 0;
  let complete = true;
  let stopped = false;
  const scannedAt = new Date().toISOString();
  const report = (problem, rootReport) => {
    complete = false;
    issues.push({ ...problem, rootId: rootReport.id });
    rootReport.issues.push(problem);
    rootReport.complete = false;
  };
  const cancelled = rootReport => {
    if (stopped) return true;
    if (signal?.aborted) {
      stopped = true;
      report(issue('SCAN_CANCELLED', '扫描已取消，未检查部分不会视为缺失', rootReport.path), rootReport);
    }
    return stopped;
  };
  async function inspect(location, rootReport) {
    try { return await inspectDirectory(location); }
    catch (error) {
      if (error.code === 'ENOENT' && location === rootReport.path && rootReport.discovered === true && rootReport.exists === false && rootReport.status === 'missing') {
        rootReport.status = 'expected-missing';
        rootReport.skipped = true;
        rootReport.reason = '候选目录尚不存在，已跳过';
        return null;
      }
      report(errorIssue(error, location), rootReport);
      return null;
    }
  }
  async function loadSkill(location, entity, rootReport) {
    const markdownPath = path.join(entity.physicalPath, 'SKILL.md');
    let raw = '';
    const readIssues = [];
    try {
      const stat = await fs.stat(markdownPath);
      const realMarkdown = await fs.realpath(markdownPath);
      if (!isWithin(entity.physicalPath, realMarkdown)) {
        readIssues.push(issue('EXTERNAL_LINK', 'SKILL.md 指向包外，未跟随读取', markdownPath));
      } else if (stat.size > maxFileBytes || bytes + stat.size > maxTotalBytes) {
        readIssues.push(issue('BYTE_BUDGET', '技能说明超过读取预算，候选已保留', markdownPath));
      } else {
        raw = await fs.readFile(markdownPath, 'utf8');
        bytes += Buffer.byteLength(raw);
      }
    } catch (error) { readIssues.push(errorIssue(error, markdownPath)); }
    const parsed = parseSkill(raw, markdownPath);
    const skill = {
      id: `skill-${digest(entity.identity).slice(0, 24)}`,
      ...parsed, raw, physicalPath: entity.physicalPath, identity: entity.identity,
      aliases: [], tools: [], scopes: [], scope: 'user', management: 'external',
      configState: 'unknown', sessionEvidence: 'none', manifest: null, hash: null,
      health: readIssues.length ? 'incomplete' : parsed.issues.length ? 'metadata-error' : 'normal',
      issues: [...readIssues, ...parsed.issues],
    };
    for (const problem of readIssues) report(problem, rootReport);
    if (hashPackages && !cancelled(rootReport)) {
      skill.manifest = await buildManifest(entity.physicalPath, { ...manifestOptions, signal, onProgress });
      skill.hash = skill.manifest.hash;
      if (!skill.manifest.complete) {
        skill.health = 'incomplete';
        skill.issues.push(...skill.manifest.issues);
        for (const problem of skill.manifest.issues) report(problem, rootReport);
      }
    }
    skills.set(entity.identity, skill);
    return skill;
  }
  function addAlias(skill, location, root, entity) {
    const scope = root.scope || 'user';
    if (!skill.aliases.some(alias => alias.path === location && alias.rootId === root.id)) {
      skill.aliases.push({ path: location, rootId: root.id, tools: [...(root.tools ?? [])], scope, kind: root.kind || 'manual', link: entity.link || location !== entity.physicalPath });
    }
    skill.tools = [...new Set([...skill.tools, ...(root.tools ?? [])])];
    skill.scopes = [...new Set([...skill.scopes, scope])];
    skill.scope = skill.scopes.length === 1 ? skill.scopes[0] : 'multiple';
    if (root.readOnly || root.kind === 'plugin') skill.management = 'readonly';
  }
  async function walk(location, root, rootReport, depth, ancestors = new Set()) {
    if (cancelled(rootReport)) return;
    if (depth > maxDepth) { report(issue('DEPTH_BUDGET', '目录超过最大扫描深度，尚未检查', location, { limit: maxDepth }), rootReport); return; }
    if (++entries > maxEntries) {
      stopped = true;
      report(issue('ENTRY_BUDGET', '目录条目超过扫描预算，尚未检查部分已保留为未知', location, { limit: maxEntries }), rootReport);
      return;
    }
    const entity = await inspect(location, rootReport);
    if (!entity) return;
    if (exclusions.some(excluded => isWithin(excluded, location) || isWithin(excluded, entity.physicalPath))) {
      rootReport.excluded.push(location);
      return;
    }
    if (ancestors.has(entity.identity)) {
      report(issue('LINK_CYCLE', '目录入口形成循环，已停止遍历此入口', location), rootReport);
      return;
    }
    let contents = cache.get(entity.identity);
    if (!contents) {
      try {
        const children = await fs.readdir(entity.physicalPath, { withFileTypes: true });
        children.sort((a, b) => compareText(a.name, b.name));
        contents = { children, skill: children.some(child => child.name === 'SKILL.md' && !child.isDirectory()) };
        cache.set(entity.identity, contents);
      } catch (error) { report(errorIssue(error, location), rootReport); return; }
    }
    rootReport.visited++;
    if (contents.skill) {
      const skill = skills.get(entity.identity) ?? await loadSkill(location, entity, rootReport);
      addAlias(skill, location, root, entity);
      rootReport.skillIds.push(skill.id);
    } else {
      const nextAncestors = new Set(ancestors).add(entity.identity);
      for (const child of contents.children) {
        if (cancelled(rootReport)) break;
        if (isExcludedDirectory(child.name)) { rootReport.excluded.push(path.join(location, child.name)); continue; }
        if (child.isDirectory() || child.isSymbolicLink()) {
          const childPath = path.join(location, child.name);
          if (child.isSymbolicLink()) {
            try {
              if (!(await fs.stat(childPath)).isDirectory()) {
                if (++entries > maxEntries) { stopped = true; report(issue('ENTRY_BUDGET', '目录条目超过扫描预算', childPath, { limit: maxEntries }), rootReport); }
                continue;
              }
            }
            catch (error) { report(errorIssue(error, childPath), rootReport); continue; }
          }
          await walk(childPath, root, rootReport, depth + 1, nextAncestors);
        } else if (++entries > maxEntries) {
          stopped = true;
          report(issue('ENTRY_BUDGET', '目录条目超过扫描预算', path.join(location, child.name), { limit: maxEntries }), rootReport);
        }
      }
    }
    onProgress?.({ phase: 'scan', path: location, roots: rootReports.length, directories: entries, skills: skills.size, bytes });
  }
  for (const [index, input] of roots.entries()) {
    const root = { ...input, id: input.id ?? `root-${index}`, path: path.resolve(input.path) };
    const rootReport = { ...root, complete: true, issues: [], excluded: [], visited: 0, skillIds: [] };
    rootReports.push(rootReport);
    if (stopped) {
      report(issue('INCOMPLETE_SCAN', '扫描提前结束，该根目录尚未检查', root.path), rootReport);
      continue;
    }
    await walk(root.path, root, rootReport, 0);
    rootReport.skillIds = [...new Set(rootReport.skillIds)];
  }
  return {
    skills: [...skills.values()].sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id)),
    issues, roots: rootReports, complete, scannedAt,
    statistics: { directories: entries, physicalSkills: skills.size, aliases: [...skills.values()].reduce((count, skill) => count + skill.aliases.length, 0), bytes },
  };
}

export function analyzeDuplicates(skills) {
  const groups = [];
  const makeGroup = (type, title, reason, members) => {
    const skillIds = members.map(skill => skill.id).sort(compareText);
    groups.push({ id: `${type}-${digest(skillIds.join('\n')).slice(0, 16)}`, type, title, reason, skillIds, canDelete: false });
  };
  const complete = skill => skill.manifest?.complete === true && typeof skill.manifest.hash === 'string';
  for (const skill of skills) {
    if ((skill.aliases?.length ?? 0) > 1) makeGroup('alias', `${skill.name} · 多个路径入口`, '这些入口指向同一物理目录；未重复占用技能包空间。', [skill]);
  }
  const byHash = new Map();
  const byName = new Map();
  const byInstruction = new Map();
  for (const skill of skills) {
    if (complete(skill)) {
      const hash = skill.manifest.hash;
      byHash.set(hash, [...(byHash.get(hash) ?? []), skill]);
    }
    byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill]);
    if (typeof skill.raw === 'string' && skill.raw.length) {
      const instruction = digest(skill.raw);
      byInstruction.set(instruction, [...(byInstruction.get(instruction) ?? []), skill]);
    }
  }
  for (const members of byHash.values()) {
    if (members.length > 1) makeGroup('identical', `${members[0].name} · 完整包相同`, '相同版本的完整清单及 SHA-256 一致；来源与安装用途独立，不能据此删除。', members);
  }
  for (const members of byInstruction.values()) {
    const checked = members.filter(complete);
    if (checked.length > 1 && new Set(checked.map(skill => skill.manifest.hash)).size > 1) {
      makeGroup('partial', `${checked[0].name} · 主说明相同`, 'SKILL.md 相同，但附件、脚本、模板或目录内容存在差异。', checked);
    }
  }
  for (const [name, members] of byName) {
    if (members.length < 2) continue;
    const checked = members.filter(complete);
    if (checked.length > 1 && new Set(checked.map(skill => skill.manifest.hash)).size > 1) {
      makeGroup('name-conflict', `${name} · 同名差异`, '名称相同但完整包不同，保留独立身份和安装关系。', checked);
    }
  }
  const unchecked = skills.filter(skill => !complete(skill));
  if (unchecked.length) makeGroup('incomplete', '完整包比较尚未完成', '尚未生成完整清单，或存在读取限制、包外链接、预算限制；不能判断完整重复。', unchecked);
  return groups;
}
