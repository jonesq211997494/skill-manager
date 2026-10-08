import path from 'node:path';
import { fail } from './errors.mjs';

// IPC 和服务入口共享这一份契约。所有失败均携带字段位置，不回显令牌或输入值。
// 未知字段一律拒绝；仅白名单内的界面展示字段可接收并剥离，不能参与写入。
// 这里只校验输入结构，目录归属、真实路径、来源身份及计划新鲜度仍由业务层复核。
function invalid(field, reason) { fail('INVALID_ARGUMENT', `请求参数 ${field} ${reason}。`, { field }); }
const optional = parse => ({ parse, optional: true });
const display = parse => ({ parse, optional: true, discard: true });
const nullable = parse => (value, field) => value === null ? null : parse(value, field);

function object(fields, check) {
  return (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field, '必须是普通对象');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !Object.hasOwn(fields, key)) invalid(`${field}.${String(key)}`, '是不支持的字段');
      if (!Object.hasOwn(descriptors[key], 'value')) invalid(`${field}.${key}`, '不能使用访问器');
    }
    const result = {};
    for (const [key, descriptor] of Object.entries(fields)) {
      const spec = typeof descriptor === 'function' ? { parse: descriptor } : descriptor;
      const input = descriptors[key]?.value;
      if (input === undefined) {
        if (!spec.optional) invalid(`${field}.${key}`, '不能为空');
        continue;
      }
      const parsed = spec.parse(input, `${field}.${key}`);
      if (!spec.discard) result[key] = parsed;
    }
    check?.(result, field);
    return result;
  };
}

function string(max, { empty = false, pattern } = {}) {
  return (value, field) => {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\x00-\x1f\x7f]/.test(value) || (pattern && !pattern.test(value))) invalid(field, `必须是${empty ? '可为空的' : '非空'}字符串，最长 ${max} 字符且格式有效`);
    return value;
  };
}
const boolean = (value, field) => { if (typeof value !== 'boolean') invalid(field, '必须是布尔值'); return value; };
const number = (min, max, integer = false) => (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid(field, `必须是 ${min} 至 ${max} 的${integer ? '整数' : '有限数值'}`);
  return value;
};
const enumeration = values => (value, field) => { if (!values.includes(value)) invalid(field, '不在允许的选项中'); return value; };
const array = (parse, max, min = 0) => (value, field) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(field, `必须是 ${min} 至 ${max} 项的数组`);
  return Array.from(value, (item, index) => parse(item, `${field}[${index}]`));
};
const id = string(256);
const tools = ['codex', 'claude', 'cursor'];
const tool = enumeration(tools);
const reservedName = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function localPath(value, field) {
  string(32767)(value, field);
  if (!path.isAbsolute(value) || /^[a-z]:[^\\/]/i.test(value) || /^\\\\[?.]\\/.test(value)) invalid(field, '必须是普通绝对路径');
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value) && !/^\\\\[^\\/]+[\\/][^\\/]+/.test(value)) invalid(field, '必须包含盘符或完整 UNC 共享位置');
  const parts = value.replace(/^[a-z]:/i, '').split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..') continue;
    if (part.length > 255 || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || reservedName.test(part)) invalid(field, '包含 Windows 不支持的路径片段');
  }
  return value;
}
function relativePath(allowEmpty = false) {
  return (value, field) => {
    string(3000, { empty: allowEmpty })(value, field);
    if (!value && allowEmpty) return value;
    const parts = value.split('/');
    if (parts.length > 60 || parts.some(part => !part || ['.', '..'].includes(part) || part.length > 255 || /[\\<>:"|?*]/.test(part) || /[. ]$/.test(part) || reservedName.test(part) || part.toLowerCase() === '.git')) invalid(field, '必须是安全的包内相对路径');
    return value;
  };
}
const scope = (value, field) => value === 'user' ? value : localPath(value, field);
const filterScope = (value, field) => ['all', 'user', 'library'].includes(value) ? value : localPath(value, field);

function webUrl(value, field) {
  string(6000)(value, field);
  let url;
  try { url = new URL(value); } catch { invalid(field, '必须是有效网页链接'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /\s/.test(value)) invalid(field, '仅允许不含凭据的 HTTP(S) 链接');
  return value;
}
function githubUrl(value, field) {
  webUrl(value, field);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port) invalid(field, '必须是 GitHub HTTPS 仓库链接');
  let parts;
  try { parts = value.replace(/^https:\/\/[^/]+/i, '').split(/[?#]/, 1)[0].split('/').filter(Boolean).map(decodeURIComponent); }
  catch { invalid(field, '包含无效的 URL 编码'); }
  if (parts.some(part => part.split('/').some(item => ['.', '..'].includes(item)) || /[\\\x00-\x1f\x7f]/.test(part))) invalid(field, '包含不安全的 URL 路径');
  if (!/^[a-z0-9-]+$/i.test(parts[0] || '') || !/^[a-z0-9_.-]+$/i.test(parts[1] || '') || ['.', '..'].includes(parts[1])) invalid(field, '缺少有效仓库名称');
  if (parts.length > 2 && (!['tree', 'blob'].includes(parts[2]) || !parts[3] || (parts[2] === 'blob' && parts.at(-1) !== 'SKILL.md'))) invalid(field, '只支持仓库、tree 目录或 SKILL.md 链接');
  return value;
}
const ref = (value, field) => {
  string(1000)(value, field);
  if (/[\x00-\x20\\~^:?*[\]]/.test(value) || value.includes('..')) invalid(field, '必须是有效分支、标签或提交引用');
  return value;
};
const sha = string(40, { pattern: /^[a-f0-9]{40}$/i });
const fullName = string(300, { pattern: /^[a-z0-9-]+\/[a-z0-9_.-]+$/i });
const repositoryId = (value, field) => typeof value === 'string' ? string(32, { pattern: /^[1-9][0-9]*$/ })(value, field) : number(1, Number.MAX_SAFE_INTEGER, true)(value, field);
const repositoryObject = object({
  id: optional(repositoryId), url: optional(githubUrl), fullName: optional(fullName),
  defaultBranch: display(ref), name: display(string(256)),
  license: display(nullable(object({ name: optional(nullable(string(500))), spdxId: optional(nullable(string(100))), url: optional(nullable(webUrl)) }))),
}, (value, field) => { if (!value.url && !value.fullName) invalid(field, '缺少仓库链接或全名'); });
const repository = (value, field) => {
  if (typeof value !== 'string') return repositoryObject(value, field);
  return value.startsWith('https:') ? githubUrl(value, field) : fullName(value, field);
};
const candidate = object({
  repository: optional(repository), repositoryId: optional(repositoryId), url: optional(githubUrl),
  path: optional(relativePath(true)), subdir: optional(relativePath(true)), ref: optional(ref), commit: sha,
  id: display(string(3300)), name: display(string(256)), stale: display(boolean), fromCache: display(boolean),
  cachedAt: display(nullable(string(64))), warning: display(nullable(string(4000))),
}, (value, field) => {
  if (!value.repository && !value.url) invalid(field, '缺少来源仓库');
  if (value.path !== undefined && value.subdir !== undefined && value.path !== value.subdir) invalid(field, '包含不一致的来源子目录');
});
const source = object({ repositoryId: optional(repositoryId), fullName: optional(fullName), url: githubUrl, ref: optional(ref), commit: sha, subdir: relativePath(true) });
const target = object({ tool, scope });
const plan = object({
  kind: enumeration(['install', 'import', 'remove', 'update', 'restore']),
  name: optional(string(200)), skillIds: optional(array(id, 1000, 1)), sourcePath: optional(localPath), source: optional(nullable(source)),
  deploymentId: optional(id), operationId: optional(id), force: optional(boolean), targets: optional(array(target, 100)),
}, (value, field) => {
  if (['install', 'import'].includes(value.kind)) {
    if (!!value.skillIds === !!value.sourcePath) invalid(field, '必须且只能指定 skillIds 或 sourcePath');
    if (value.kind === 'install' && !value.targets?.length) invalid(`${field}.targets`, '至少需要一个安装目标');
    // 批量安装时 name 仅用于对话框标题；单包安装时 name 才是目录名。
    if (value.sourcePath && value.name !== undefined && (value.name.length > 150 || /[<>:"/\\|?*]/.test(value.name) || /[. ]$/.test(value.name) || reservedName.test(value.name) || ['.', '..'].includes(value.name))) invalid(`${field}.name`, '必须是安全的技能目录名');
  }
  if (['remove', 'update'].includes(value.kind) && !value.deploymentId) invalid(`${field}.deploymentId`, '不能为空');
  if (value.kind === 'update' && !value.sourcePath) invalid(`${field}.sourcePath`, '不能为空');
  if (value.kind === 'restore' && !value.operationId) invalid(`${field}.operationId`, '不能为空');
});
const proxy = (value, field) => {
  string(2048, { empty: true })(value, field);
  if (!value) return value;
  let parsed;
  try { parsed = new URL(value); } catch { invalid(field, '必须是有效代理地址'); }
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /\s/.test(value) || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) invalid(field, '必须是不含凭据的 HTTP、HTTPS 或 SOCKS5 代理地址');
  return value;
};
const settings = object({
  theme: optional(enumeration(['light', 'dark', 'system'])), fontSize: optional(number(12, 20, true)),
  libraryPath: optional(localPath), proxy: optional(proxy),
  backupDays: optional(number(1, 36500, true)), backupMinimum: optional(number(1, 10000, true)), backupLimitGB: optional(number(Number.MIN_VALUE, 1000000)),
  // bootstrap 返回项目列表供设置页展示，保存时不能把它当作可写配置。
  projects: display(array(object({ id, path: localPath, name: string(255) }), 1000)),
});

const noArgs = object({});
const byId = object({ id });
const contracts = {
  bootstrap: noArgs,
  'github.status': noArgs,
  'github.loginToken': object({ token: string(1024, { pattern: /^[a-z0-9_.-]{8,1024}$/i }) }),
  'github.loginBrowser': object({ username: string(39, { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/i }) }),
  'github.logout': noArgs, 'github.cancelLogin': noArgs, 'github.openTokenPage': noArgs,
  scan: noArgs, 'scan.start': noArgs,
  'jobs.cancel': object({ id: optional(enumeration(['scan', 'updates', 'duplicates', 'download'])) }),
  'storage.usage': noArgs,
  'skills.source.inspect': object({ id, url: githubUrl, ref: optional(ref) }),
  'skills.source.preview': object({ id, candidate }),
  'skills.source.bind': object({ previewId: id }), 'skills.source.unbind': byId, 'skills.detail': byId,
  'skills.organize': object({ id, alias: optional(string(200, { empty: true })), tags: optional(array(string(50), 50)), favorite: optional(boolean), pinned: optional(boolean) }),
  'duplicates.analyze': noArgs,
  'roots.add': object({ path: localPath, kind: optional(enumeration(['manual', 'active', 'candidate', 'backup', 'history', 'cache', 'library', 'plugin'])), tools: optional(array(tool, 3)), scope: optional(scope) }),
  'roots.remove': byId, 'projects.add': object({ path: localPath }), 'projects.remove': byId,
  'settings.save': settings,
  'sources.add': object({ url: githubUrl }), 'sources.remove': byId,
  'sources.search': object({ query: string(500), page: optional(number(1, 1000, true)), forceRefresh: optional(boolean) }),
  'sources.inspect': object({ url: githubUrl, ref: optional(ref), forceRefresh: optional(boolean) }),
  'sources.preview': object({ candidate }),
  'updates.check': object({ skillIds: optional(array(id, 1000)), tool: optional(enumeration([...tools, 'all', 'external', 'library'])), scope: optional(filterScope) }),
  'operations.plan': plan,
  'operations.execute': object({ planId: id, digest: string(256) }),
  'operations.refresh': byId, 'operations.history': noArgs, 'operations.status': byId,
  'migration.preview': object({ path: localPath }), 'migration.import': byId,
  'dialog.directory': noArgs, 'dialog.file': noArgs,
  'files.compare': object({ deploymentId: optional(id), bindingId: optional(id), remotePath: optional(localPath), relativePath: optional(relativePath()) }, (value, field) => {
    if (!!value.deploymentId === !!value.bindingId) invalid(field, '必须且只能指定 deploymentId 或 bindingId');
  }),
  'files.open': object({ path: localPath }), 'links.open': object({ url: webUrl }),
};

export const IPC_METHODS = Object.freeze(Object.keys(contracts));

/** 完整校验后返回可传给业务层的新对象；不会改写传入参数或产生外部副作用。 */
export function parseIpcArgs(method, args = {}) {
  if (typeof method !== 'string' || !Object.hasOwn(contracts, method)) fail('UNKNOWN_METHOD', '此操作不可用。');
  return contracts[method](args, 'args');
}
