import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.github.com';
const SHA = /^[a-f0-9]{40}$/i;
const CACHE_TTL_MS = 5 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const gitHash = content => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
const DEFAULT_LIMITS = Object.freeze({
  files: 10000, fileBytes: 16 * 1024 * 1024, totalBytes: 256 * 1024 * 1024,
  treeEntries: 100000, treeRequests: 500, responseBytes: 16 * 1024 * 1024,
  timeoutMs: 30000,
});

export class SourceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.details = details;
    this.retryable = ['SOURCE_UNAVAILABLE', 'RATE_LIMITED'].includes(code);
    Object.assign(this, details);
  }
}

function fail(code, message, details) { throw new SourceError(code, message, details); }
function checkAbort(signal) {
  if (signal?.aborted) fail('CANCELLED', '来源任务已取消。');
}
function validatePath(value, allowEmpty = false) {
  if (typeof value !== 'string' || (!value && !allowEmpty)) fail('UNSAFE_PATH', '来源路径为空。');
  if (!value && allowEmpty) return '';
  const parts = value.split('/');
  if (value.length > 3000 || parts.length > 60) fail('UNSAFE_PATH', '来源路径过长或嵌套过深。');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.length > 255 || /[\\<>:"|?*\x00-\x1f\x7f]/.test(part)
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
      || part.toLowerCase() === '.git') fail('UNSAFE_PATH', `来源包含 Windows 不安全路径：${value}`);
  }
  return value;
}

// 在 URL 解析器消除 ../ 之前检查原始路径，避免把恶意输入规范化成合法链接。
export function parseGitHubUrl(input) {
  if (typeof input !== 'string' || input.length > 6000) fail('INVALID_SOURCE_URL', '请输入公开 GitHub 仓库或技能目录链接。');
  const raw = input.trim();
  let url;
  try { url = new URL(raw); } catch { fail('INVALID_SOURCE_URL', 'GitHub 链接格式无效。'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.port)
    fail('INVALID_SOURCE_URL', '仅接受无凭据的 https://github.com 公开仓库链接。');
  const rawPath = raw.replace(/^https:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
  let parts;
  try { parts = rawPath.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { fail('INVALID_SOURCE_URL', '链接包含无效编码。'); }
  if (parts.some(p => p.split('/').some(s => s === '.' || s === '..') || /[\\\x00-\x1f]/.test(p)))
    fail('UNSAFE_PATH', '链接包含越界路径。');
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, '');
  if (!owner || !repo || !/^[a-z0-9-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repo) || repo === '.' || repo === '..')
    fail('INVALID_SOURCE_URL', '链接必须包含有效的 GitHub 用户名和仓库名。');
  const kind = parts[2] || 'repository';
  if ((parts.length > 2 && !['tree', 'blob'].includes(kind)) || (kind !== 'repository' && !parts[3]))
    fail('INVALID_SOURCE_URL', '支持仓库、tree 目录和 blob/SKILL.md 链接。');
  const tail = parts.slice(3).join('/');
  if (kind === 'blob' && !tail.endsWith('/SKILL.md')) fail('INVALID_SOURCE_URL', '文件链接必须指向 SKILL.md。');
  return { owner, repo, fullName: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}`, kind, tail };
}

function repositoryInput(repository, fallback) {
  if (typeof repository === 'string') return parseGitHubUrl(repository.startsWith('https:') ? repository : `https://github.com/${repository}`);
  return parseGitHubUrl(repository?.url || (repository?.fullName ? `https://github.com/${repository.fullName}` : fallback));
}
function validSha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) fail('SOURCE_INVALID', 'GitHub 未返回有效的固定提交或对象标识。');
  return value.toLowerCase();
}
function refPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\x00-\x20\\~^:?*[\]]/.test(value) || value.includes('..'))
    fail('INVALID_REF', '分支、标签或提交引用无效。');
  return encodeURIComponent(value);
}
function apiRepo(parsed) { return `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`; }

export class SourceService {
  constructor({ dataDir, fetchImpl = globalThis.fetch, limits = {}, getCredential = async () => null,
    requireAuth = false, onUnauthorized, onRateLimit, now = () => Date.now() }) {
    if (!dataDir || typeof fetchImpl !== 'function') throw new TypeError('需要 dataDir 和 fetch 实现。');
    this.dataDir = path.resolve(dataDir);
    this.fetch = fetchImpl;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('来源预算必须为正整数。');
    this.getCredential = getCredential;
    this.requireAuth = requireAuth;
    this.onUnauthorized = onUnauthorized;
    this.onRateLimit = onRateLimit;
    this.now = now;
    this.epoch = 0;
    this.authAbort = new AbortController();
    this.contexts = new WeakMap();
    this.inflight = new Map();
    this.immutable = new Map();
    this.requestQueue = Promise.resolve();
    this.resources = {};
    this.cooldownUntil = 0;
  }

  resetAuthState() {
    this.epoch++;
    this.authAbort.abort();
    this.authAbort = new AbortController();
    this.inflight.clear();
    this.immutable.clear();
    this.resources = {};
    this.cooldownUntil = 0;
  }

  status() {
    return { resources: structuredClone(this.resources),
      cooldownUntil: this.cooldownUntil > this.now() ? new Date(this.cooldownUntil).toISOString() : null };
  }

  async _context(signal) {
    checkAbort(signal);
    const epoch = this.epoch;
    const credential = await this.getCredential();
    if (epoch !== this.epoch) fail('AUTH_CHANGED', 'GitHub 账号已变更，请重新执行操作。');
    if (this.requireAuth && !credential?.token) fail('GITHUB_LOGIN_REQUIRED', '请先登录 GitHub，再使用在线来源。');
    if (credential?.token && !credential.cacheKey) fail('GITHUB_LOGIN_REQUIRED', 'GitHub 登录状态无效，请重新登录。');
    const combined = AbortSignal.any([this.authAbort.signal, ...(signal ? [signal] : [])]);
    const context = { epoch, credential, scope: digest(credential?.cacheKey || 'anonymous-v2'), signal: combined };
    this.contexts.set(combined, context);
    this._ensure(context);
    return context;
  }

  _ensure(context) {
    if (context.epoch !== this.epoch) fail('AUTH_CHANGED', 'GitHub 账号已变更，请重新执行操作。');
    checkAbort(context.signal);
  }

  async _once(key, loader, context) {
    this._ensure(context);
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = Promise.resolve().then(loader);
      this.inflight.set(key, pending);
      pending.finally(() => { if (this.inflight.get(key) === pending) this.inflight.delete(key); }).catch(() => {});
    }
    const result = await pending;
    this._ensure(context);
    return structuredClone(result);
  }

  _rateError(resource, retryAt, status = 429, reset = null) {
    const retryAfter = Math.max(1, Math.ceil((retryAt - this.now()) / 1000));
    const details = { status, resource, reset, retryAt: new Date(retryAt).toISOString(), retryAfter };
    this.onRateLimit?.(details);
    return new SourceError('RATE_LIMITED', `GitHub 请求受限，请在 ${new Date(retryAt).toLocaleTimeString('zh-CN', { hour12: false })} 后重试。`, details);
  }

  _checkCooldown(resource) {
    const specific = this.resources[resource];
    const until = Math.max(this.cooldownUntil, specific?.cooldownUntil ? Date.parse(specific.cooldownUntil) : 0);
    if (until > this.now()) throw this._rateError(this.cooldownUntil >= until ? 'secondary' : resource, until, 429, specific?.reset || null);
  }

  _recordRate(response, fallbackResource) {
    const header = name => response.headers?.get(name);
    const resource = header('x-ratelimit-resource') || fallbackResource;
    const previous = this.resources[resource] || {};
    const values = { ...previous };
    for (const [name, key] of [['x-ratelimit-limit', 'limit'], ['x-ratelimit-remaining', 'remaining'], ['x-ratelimit-used', 'used']]) {
      const value = header(name);
      if (value != null && Number.isFinite(Number(value))) values[key] = Number(value);
    }
    const reset = Number(header('x-ratelimit-reset')) * 1000;
    if (Number.isFinite(reset) && reset > 0 && reset <= 8640000000000000) values.reset = new Date(reset).toISOString();
    if (values.remaining === 0 && reset > this.now()) values.cooldownUntil = new Date(reset).toISOString();
    else if (values.remaining > 0) delete values.cooldownUntil;
    if (Object.keys(values).length) this.resources[resource] = values;
    return resource;
  }

  async _readResponse(response, maxBytes, signal) {
    const contentLength = Number(response.headers?.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      fail('SOURCE_LIMIT', '远端响应超过允许的大小。');
    }
    const chunks = [];
    let length = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          checkAbort(signal);
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) { await reader.cancel(); fail('SOURCE_LIMIT', '远端响应超过允许的大小。'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks, length);
    }
    // 标准 fetch 总是提供流；此分支兼容自定义离线测试和连接器。
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) fail('SOURCE_LIMIT', '远端响应超过允许的大小。');
    return buffer;
  }

  async _request(endpoint, { signal, raw = false, maxBytes = this.limits.responseBytes } = {}) {
    const context = this.contexts.get(signal) || await this._context(signal);
    const perform = async () => {
      this._ensure(context);
      const url = new URL(endpoint, API);
      if (url.origin !== API || url.username || url.password) fail('SOURCE_INVALID', '请求必须发送至 GitHub API。');
      const resource = url.pathname.startsWith('/search/') ? 'search' : 'core';
      this._checkCooldown(resource);
      const timeout = AbortSignal.timeout(this.limits.timeoutMs);
      const combined = AbortSignal.any([context.signal, timeout]);
      try {
        let requestUrl = url.href;
        let response;
        for (let redirects = 0; ; redirects++) {
          this._ensure(context);
          this._checkCooldown(resource);
          const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'SkillManager/0.2.0' };
          if (context.credential?.token) headers.Authorization = `Bearer ${context.credential.token}`;
          response = await this.fetch(requestUrl, { headers, signal: combined, redirect: 'manual' });
          this._ensure(context);
          this._recordRate(response, resource);
          if (![301, 302, 307, 308].includes(response.status)) break;
          const location = response.headers?.get('location');
          await response.body?.cancel().catch(() => {});
          if (!location || redirects >= 4) fail('SOURCE_UNAVAILABLE', 'GitHub 来源重定向异常。');
          const redirected = new URL(location, requestUrl);
          if (redirected.origin !== API || redirected.username || redirected.password)
            fail('SOURCE_INVALID', '拒绝跳转到 GitHub API 之外的来源。');
          requestUrl = redirected.href;
        }
        if (!response.ok) {
          if (response.status === 401 && context.credential?.token) {
            await response.body?.cancel().catch(() => {});
            await this.onUnauthorized?.(context.credential.cacheKey);
            fail('GITHUB_SESSION_EXPIRED', 'GitHub 登录已失效，请重新登录。', { status: 401 });
          }
          const resetHeader = Number(response.headers?.get('x-ratelimit-reset'));
          const resetMs = resetHeader > 0 && resetHeader * 1000 <= 8640000000000000 ? resetHeader * 1000 : 0;
          const reset = resetMs ? new Date(resetMs).toISOString() : null;
          const retryHeader = response.headers?.get('retry-after');
          const retryMs = retryHeader == null ? 0 : (/^\d+(?:\.\d+)?$/.test(retryHeader.trim())
            ? this.now() + Number(retryHeader) * 1000 : Date.parse(retryHeader));
          const body = (await this._readResponse(response, Math.min(maxBytes, 65536), combined)).toString('utf8');
          if (response.status === 429 || (response.status === 403 && (response.headers?.get('x-ratelimit-remaining') === '0' || retryHeader != null || /rate limit|secondary rate|abuse detection/i.test(body)))) {
            const primary = response.headers?.get('x-ratelimit-remaining') === '0';
            const rateResource = primary ? (response.headers?.get('x-ratelimit-resource') || resource) : 'secondary';
            const retryAt = retryMs > this.now() ? retryMs : primary && resetMs > this.now() ? resetMs : this.now() + 60000;
            if (primary) this.resources[rateResource] = { ...this.resources[rateResource], cooldownUntil: new Date(retryAt).toISOString() };
            else this.cooldownUntil = Math.max(this.cooldownUntil, retryAt);
            throw this._rateError(rateResource, retryAt, response.status, reset);
          }
          if ([401, 403].includes(response.status)) fail('SOURCE_AUTH_REQUIRED', '此来源不可读取或 GitHub 拒绝访问。', { status: response.status });
          if (response.status === 404) fail('SOURCE_NOT_FOUND', '仓库、引用或目录不存在，或无权读取此来源。', { status: 404 });
          fail('SOURCE_UNAVAILABLE', `GitHub 请求失败（HTTP ${response.status}）。`, { status: response.status });
        }
        const buffer = await this._readResponse(response, maxBytes, combined);
        this._ensure(context);
        if (raw) return buffer;
        try { return JSON.parse(buffer.toString('utf8')); }
        catch { fail('SOURCE_INVALID', 'GitHub 返回的内容不是有效 JSON。'); }
      } catch (error) {
        if (error.code === 'GITHUB_SESSION_EXPIRED') throw error;
        this._ensure(context);
        if (error instanceof SourceError) throw error;
        fail('SOURCE_UNAVAILABLE', timeout.aborted ? 'GitHub 请求超时，请检查网络后重试。' : '无法连接 GitHub，请检查网络或代理设置。');
      }
    };
    const pending = this.requestQueue.catch(() => {}).then(perform);
    this.requestQueue = pending.then(() => {}, () => {});
    return pending;
  }

  async _readJson(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.limits.responseBytes * 2) throw new Error('invalid cache');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }

  async _writeJson(file, value, context) {
    this._ensure(context);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
      this._ensure(context);
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async _cached(key, loader, { context, forceRefresh = false } = {}) {
    const scoped = `${context.scope}:${key}`;
    const file = path.join(this.dataDir, 'cache', `source-${digest(scoped)}.json`);
    return this._once(`${context.epoch}:${scoped}:${forceRefresh}`, async () => {
      let cached;
      try {
        cached = await this._readJson(file);
        if (!cached.cachedAt || !Number.isFinite(Date.parse(cached.cachedAt))) cached = null;
      } catch { /* 缓存缺失或无效时，只有重新请求成功才写入缓存。 */ }
      this._ensure(context);
      if (cached && !forceRefresh && this.now() - Date.parse(cached.cachedAt) >= 0 && this.now() - Date.parse(cached.cachedAt) < CACHE_TTL_MS)
        return { ...cached, stale: false, fromCache: true };
      try {
        const loaded = await loader();
        this._ensure(context);
        const result = { ...loaded, cachedAt: new Date(this.now()).toISOString(), stale: false, fromCache: false,
          refreshAfter: new Date(this.now() + CACHE_TTL_MS).toISOString() };
        await this._writeJson(file, result, context);
        return result;
      } catch (error) {
        if (error.code === 'GITHUB_SESSION_EXPIRED') throw error;
        this._ensure(context);
        if (!cached || !['SOURCE_UNAVAILABLE', 'RATE_LIMITED'].includes(error.code)) throw error;
        return { ...cached, fromCache: true, stale: true,
          warning: `${error.message} 当前展示缓存，不能据此认定远端版本为最新。`, warningCode: error.code,
          reset: error.reset || null, retryAt: error.retryAt || null, retryAfter: error.retryAfter || null, resource: error.resource || null };
      }
    }, context);
  }

  async _immutableRequest(endpoint, signal) {
    const context = this.contexts.get(signal);
    const key = `${context.epoch}:${context.scope}:${endpoint}`;
    this._ensure(context);
    if (this.immutable.has(key)) return structuredClone(this.immutable.get(key));
    return this._once(`immutable:${key}`, async () => {
      const result = await this._request(endpoint, { signal });
      this._ensure(context);
      this.immutable.set(key, result);
      return result;
    }, context);
  }

  async search(query, page = 1, { forceRefresh = false, signal } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 256) fail('INVALID_QUERY', '请输入 1 至 256 个字符的仓库关键词。');
    if (!Number.isSafeInteger(page) || page < 1 || page > 34) fail('INVALID_PAGE', 'GitHub 仓库搜索仅支持前 1000 个结果。');
    const q = query.trim();
    const context = await this._context(signal);
    return this._cached(`search:${q}:${page}`, async () => {
      const result = await this._request(`/search/repositories?q=${encodeURIComponent(`${q} is:public`)}&sort=stars&order=desc&per_page=30&page=${page}`, { signal: context.signal });
      if (!Array.isArray(result.items)) fail('SOURCE_INVALID', 'GitHub 仓库列表格式无效。');
      return { items: result.items.map(item => ({ id: item.id, name: item.name, fullName: item.full_name,
        url: item.html_url, description: item.description || '', stars: item.stargazers_count || 0, author: item.owner?.login || '' })),
      page, perPage: 30, total: result.total_count || 0, maxPages: Math.ceil(Math.min(result.total_count || 0, 1000) / 30),
      hasMore: page * 30 < Math.min(result.total_count || 0, 1000), incomplete: !!result.incomplete_results,
      ...(result.incomplete_results ? { warning: 'GitHub 返回了部分搜索结果，可稍后重试。' } : {}) };
    }, { context, forceRefresh });
  }

  async _commit(parsed, ref, signal) {
    const endpoint = `${apiRepo(parsed)}/commits/${refPath(ref)}`;
    const response = SHA.test(ref) ? await this._immutableRequest(endpoint, signal) : await this._request(endpoint, { signal });
    return { sha: validSha(response.sha), tree: validSha(response.commit?.tree?.sha) };
  }

  async _resolve(parsed, defaultBranch, explicitRef, signal) {
    if (parsed.kind === 'repository') {
      const ref = explicitRef || defaultBranch;
      return { ref, subdir: '', ...await this._commit(parsed, ref, signal) };
    }
    if (explicitRef) {
      if (parsed.tail !== explicitRef && !parsed.tail.startsWith(`${explicitRef}/`)) fail('REF_PATH_MISMATCH', '指定引用与链接中的引用前缀不符，请使用仓库链接或匹配的目录链接。');
      const suffix = parsed.tail.slice(explicitRef.length).replace(/^\//, '');
      return { ref: explicitRef, subdir: validatePath(parsed.kind === 'blob' ? suffix.replace(/(^|\/)SKILL\.md$/, '') : suffix, true),
        ...await this._commit(parsed, explicitRef, signal) };
    }
    const pieces = parsed.tail.split('/');
    if (pieces.length > 24) fail('INVALID_REF', '链接过深，请显式指定分支或提交引用。');
    const matches = [];
    const max = parsed.kind === 'blob' ? pieces.length - 1 : pieces.length;
    // API 逐项核验最长引用；同时检查较短引用，歧义必须由调用者显式选择。
    for (let count = max; count >= 1; count--) {
      const ref = pieces.slice(0, count).join('/');
      try {
        const commit = await this._commit(parsed, ref, signal);
        const suffix = pieces.slice(count).join('/');
        const subdir = parsed.kind === 'blob' ? suffix.replace(/(^|\/)SKILL\.md$/, '') : suffix;
        matches.push({ ref, subdir: validatePath(subdir, true), ...commit });
      } catch (error) { if (error.code !== 'SOURCE_NOT_FOUND') throw error; }
    }
    if (!matches.length) fail('SOURCE_NOT_FOUND', '链接中没有可解析的分支、标签或提交。');
    if (matches.length > 1) fail('AMBIGUOUS_REF', '链接对应多个有效引用，请明确选择分支或标签。', { candidates: matches.map(({ ref, subdir }) => ({ ref, path: subdir })) });
    return matches[0];
  }

  async _tree(parsed, sha, recursive, signal) {
    const tree = await this._immutableRequest(`${apiRepo(parsed)}/git/trees/${validSha(sha)}${recursive ? '?recursive=1' : ''}`, signal);
    if (!Array.isArray(tree.tree)) fail('SOURCE_INVALID', 'GitHub 文件树格式无效。');
    if (!recursive && tree.truncated) fail('SOURCE_TRUNCATED', 'GitHub 单层文件树被截断，无法安全构建完整技能包。');
    return tree;
  }

  async _entries(parsed, sha, signal) {
    const recursive = await this._tree(parsed, sha, true, signal);
    if (!recursive.truncated) {
      if (recursive.tree.length > this.limits.treeEntries) fail('SOURCE_LIMIT', '仓库文件树超过条目预算。');
      return recursive.tree;
    }
    // 截断结果不可作为完整快照；重新逐层读取，每层均验证完整性。
    const queue = [{ sha, prefix: '', depth: 0 }];
    const entries = [];
    let requests = 0;
    while (queue.length) {
      checkAbort(signal);
      if (++requests > this.limits.treeRequests) fail('SOURCE_LIMIT', '来源目录请求超过预算，请指定更小的技能目录。');
      const next = queue.shift();
      if (next.depth > 60) fail('SOURCE_LIMIT', '来源目录嵌套过深。');
      const tree = await this._tree(parsed, next.sha, false, signal);
      for (const entry of tree.tree) {
        if (typeof entry.path !== 'string' || entry.path.includes('/')) fail('SOURCE_INVALID', '单层 Git 文件树含无效路径。');
        const fullPath = `${next.prefix}${entry.path}`;
        entries.push({ ...entry, path: fullPath });
        if (entries.length > this.limits.treeEntries) fail('SOURCE_LIMIT', '仓库文件树超过条目预算。');
        if (entry.type === 'tree') queue.push({ sha: validSha(entry.sha), prefix: `${fullPath}/`, depth: next.depth + 1 });
      }
    }
    return entries;
  }

  async _subtree(parsed, rootSha, subdir, signal) {
    let sha = rootSha;
    if (!subdir) return sha;
    for (const part of validatePath(subdir).split('/')) {
      const tree = await this._tree(parsed, sha, false, signal);
      const entry = tree.tree.find(item => item.path === part);
      if (!entry) fail('SOURCE_NOT_FOUND', `来源目录不存在：${subdir}`);
      if (entry.type !== 'tree' || entry.mode !== '040000') fail('UNSAFE_PATH', '技能目录不是普通 Git 目录。');
      sha = validSha(entry.sha);
    }
    return sha;
  }

  async inspect(url, { ref, signal, forceRefresh = false } = {}) {
    const parsed = parseGitHubUrl(url);
    const context = await this._context(signal);
    signal = context.signal;
    return this._cached(`inspect:${parsed.url}:${parsed.kind}:${parsed.tail}:${ref || ''}`, async () => {
      const repo = await this._request(apiRepo(parsed), { signal });
      if (!Number.isSafeInteger(repo.id) || !repo.default_branch) fail('SOURCE_INVALID', '仓库元数据缺少稳定标识或默认分支。');
      const canonical = parseGitHubUrl(repo.html_url);
      const resolved = await this._resolve({ ...canonical, kind: parsed.kind, tail: parsed.tail }, repo.default_branch, ref, signal);
      const treeSha = await this._subtree(canonical, resolved.tree, resolved.subdir, signal);
      const entries = await this._entries(canonical, treeSha, signal);
      const skills = entries.filter(entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)
        && (entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'))).map(entry => {
        const relative = entry.path === 'SKILL.md' ? '' : entry.path.slice(0, -'/SKILL.md'.length);
        const subdir = [resolved.subdir, relative].filter(Boolean).join('/');
        validatePath(subdir, true);
        return { id: `${repo.id}:${subdir}`, name: subdir.split('/').at(-1) || repo.name || canonical.repo,
          path: subdir, url: `${canonical.url}/tree/${resolved.sha}${subdir ? `/${subdir.split('/').map(encodeURIComponent).join('/')}` : ''}` };
      }).sort((a, b) => a.path.localeCompare(b.path));
      return { repository: { id: repo.id, fullName: canonical.fullName, url: canonical.url, defaultBranch: repo.default_branch,
        license: repo.license ? { name: repo.license.name, spdxId: repo.license.spdx_id, url: repo.license.url } : null },
      ref: resolved.ref, commit: resolved.sha, skills };
    }, { context, forceRefresh });
  }

  _validateEntries(entries) {
    const known = new Map();
    const files = [];
    let bytes = 0;
    for (const entry of entries) {
      validatePath(entry.path);
      const isDirectory = entry.type === 'tree' && entry.mode === '040000';
      if (!isDirectory && (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)))
        fail('UNSAFE_ENTRY', `技能包包含符号链接、子模块或未知文件类型：${entry.path}`);
      const parts = entry.path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const spelling = parts.slice(0, i).join('/');
        const key = spelling.toLowerCase();
        const type = i < parts.length || isDirectory ? 'directory' : 'file';
        const previous = known.get(key);
        if (previous && (previous.spelling !== spelling || previous.type !== type || type === 'file'))
          fail('PATH_CASE_CONFLICT', `技能包在 Windows 上存在名称冲突：${spelling}`);
        known.set(key, { spelling, type });
      }
      if (isDirectory) continue;
      validSha(entry.sha);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail('SOURCE_INVALID', `文件大小无效：${entry.path}`);
      if (entry.size > this.limits.fileBytes) fail('SOURCE_LIMIT', `单个文件超过大小限制：${entry.path}`);
      bytes += entry.size;
      files.push(entry);
      if (files.length > this.limits.files || bytes > this.limits.totalBytes) fail('SOURCE_LIMIT', '技能包文件数或总大小超过下载预算。');
    }
    if (!files.some(entry => entry.path === 'SKILL.md')) fail('INVALID_SKILL_PACKAGE', '所选目录根部缺少 SKILL.md，不能作为一个技能安装。');
    return { files, bytes };
  }

  async _readPackage(file, candidate, context) {
    try {
      const cached = await this._readJson(file);
      const expectedId = candidate.repository?.id ?? candidate.repositoryId;
      const subdir = candidate.path ?? candidate.subdir ?? '';
      if (String(cached.source?.repositoryId) !== String(expectedId) || cached.source.commit !== candidate.commit.toLowerCase()
        || cached.source.subdir !== subdir || !Array.isArray(cached.files) || !cached.cachedAt) return null;
      // 不信任索引中的绝对路径：只复用暂存服务在 staging 下创建的直属目录。
      const stageBase = path.join(this.dataDir, 'staging');
      const relative = path.relative(stageBase, cached.path);
      if (!relative.startsWith('source-') || relative.includes(path.sep) || path.isAbsolute(relative)) return null;
      const rootStat = await fs.lstat(cached.path);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
      const entries = cached.files.map(entry => ({ path: entry.path, size: entry.size, sha: entry.gitSha, type: 'blob', mode: '100644' }));
      const { bytes } = this._validateEntries(entries);
      if (bytes !== cached.bytes) return null;
      const expected = new Map(cached.files.map(entry => [entry.path, entry]));
      const directories = new Set();
      for (const entry of cached.files) {
        const pieces = entry.path.split('/');
        for (let i = 1; i < pieces.length; i++) directories.add(pieces.slice(0, i).join('/'));
      }
      let found = 0;
      const walk = async (directory, prefix = '') => {
        this._ensure(context);
        for (const name of await fs.readdir(directory)) {
          const relativePath = prefix ? `${prefix}/${name}` : name;
          const absolute = path.join(directory, name);
          const stat = await fs.lstat(absolute);
          if (stat.isSymbolicLink()) throw new Error('linked cache');
          if (stat.isDirectory()) {
            if (!directories.has(relativePath)) throw new Error('extra directory');
            await walk(absolute, relativePath);
          } else {
            const expectedFile = expected.get(relativePath);
            if (!stat.isFile() || stat.nlink > 1 || !expectedFile || stat.size !== expectedFile.size) throw new Error('unexpected file');
            const content = await fs.readFile(absolute);
            if (gitHash(content) !== expectedFile.gitSha.toLowerCase() || digest(content) !== expectedFile.sha256) throw new Error('modified cache');
            found++;
          }
        }
      };
      await walk(cached.path);
      this._ensure(context);
      if (found !== expected.size) return null;
      return { ...cached, source: { ...cached.source, ref: candidate.ref || cached.source.commit },
        fromCache: true, stale: false, refreshAfter: null };
    } catch (error) {
      if (['CANCELLED', 'AUTH_CHANGED'].includes(error.code)) throw error;
      return null;
    }
  }

  async _blob(parsed, entry, context) {
    const file = path.join(this.dataDir, 'cache', 'blobs', context.scope, validSha(entry.sha));
    this._ensure(context);
    try {
      const stat = await fs.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === entry.size) {
        const content = await fs.readFile(file);
        this._ensure(context);
        if (gitHash(content) === entry.sha.toLowerCase()) return content;
      }
    } catch (error) { if (['CANCELLED', 'AUTH_CHANGED'].includes(error.code)) throw error; }
    const content = await this._request(`${apiRepo(parsed)}/git/blobs/${entry.sha}`, { signal: context.signal, raw: true, maxBytes: this.limits.fileBytes });
    if (content.length !== entry.size || gitHash(content) !== entry.sha.toLowerCase())
      fail('SOURCE_INTEGRITY', `远端文件内容与 Git 对象摘要不符：${entry.path}`);
    this._ensure(context);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { flag: 'wx' });
      this._ensure(context);
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return content;
  }

  async download(candidate, { signal, onProgress, forceRefresh = false } = {}) {
    if (!candidate || typeof candidate !== 'object') fail('INVALID_SOURCE', '缺少技能来源。');
    const parsed = repositoryInput(candidate.repository, candidate.url);
    const commit = validSha(candidate.commit);
    const subdir = validatePath(candidate.path ?? candidate.subdir ?? '', true);
    const context = await this._context(signal);
    const expectedId = candidate.repository?.id ?? candidate.repositoryId;
    if (expectedId != null && (!/^\d+$/.test(String(expectedId)) || Number(expectedId) <= 0)) fail('SOURCE_INVALID', '仓库身份标识无效。');
    const packageKey = `${context.scope}:${expectedId ?? parsed.fullName}:${commit}:${subdir}`;
    const downloaded = await this._once(`${context.epoch}:download:${packageKey}:${forceRefresh}`, async () => {
      const indexFile = path.join(this.dataDir, 'cache', 'packages', `${digest(packageKey)}.json`);
      if (expectedId != null && !forceRefresh) {
        const cached = await this._readPackage(indexFile, candidate, context);
        if (cached) {
          onProgress?.({ files: cached.files.length, totalFiles: cached.files.length, bytes: cached.bytes, totalBytes: cached.bytes, fromCache: true });
          return cached;
        }
      }
      return this._download(candidate, { parsed, commit, subdir, context, onProgress, indexFile });
    }, context);
    // 多个分支可共享相同提交内容，但各调用方必须保留自己的后续更新引用。
    return { ...downloaded, source: { ...downloaded.source, ref: candidate.ref || commit } };
  }

  async _download(candidate, { parsed, commit, subdir, context, onProgress, indexFile }) {
    const signal = context.signal;
    const repository = await this._request(apiRepo(parsed), { signal });
    if (!Number.isSafeInteger(repository.id)) fail('SOURCE_INVALID', '仓库未返回稳定身份标识。');
    const expectedId = candidate.repository?.id ?? candidate.repositoryId;
    if (expectedId != null && String(expectedId) !== String(repository.id))
      fail('SOURCE_IDENTITY_CHANGED', '此链接现在指向不同的仓库，请重新检查来源后再安装。');
    parsed = parseGitHubUrl(repository.html_url);
    const resolved = await this._commit(parsed, commit, signal);
    if (resolved.sha !== commit) fail('SOURCE_INVALID', '固定提交与 GitHub 返回结果不一致。');
    const subtree = await this._subtree(parsed, resolved.tree, subdir, signal);
    const entries = await this._entries(parsed, subtree, signal);
    const { files, bytes: totalBytes } = this._validateEntries(entries);
    const stageBase = path.join(this.dataDir, 'staging');
    await fs.mkdir(stageBase, { recursive: true });
    const stage = await fs.mkdtemp(path.join(stageBase, 'source-'));
    let bytes = 0;
    const manifest = [];
    try {
      for (const entry of files) {
        this._ensure(context);
        const content = await this._blob(parsed, entry, context);
        const destination = path.resolve(stage, ...entry.path.split('/'));
        const relative = path.relative(stage, destination);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('UNSAFE_PATH', '下载目标越过暂存目录。');
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content, { flag: 'wx' });
        bytes += content.length;
        manifest.push({ path: entry.path, size: content.length, sha256: digest(content), gitSha: entry.sha });
        onProgress?.({ files: manifest.length, totalFiles: files.length, bytes, totalBytes, path: entry.path });
      }
      this._ensure(context);
      const result = { path: stage, source: { repositoryId: repository.id,
        fullName: parsed.fullName, url: parsed.url, ref: candidate.ref || commit, commit, subdir }, files: manifest, bytes,
        cachedAt: new Date(this.now()).toISOString(), fromCache: false, stale: false, refreshAfter: null };
      await this._writeJson(indexFile, result, context);
      return result;
    } catch (error) {
      const relative = path.relative(stageBase, stage);
      if (relative.startsWith('source-') && !relative.includes(path.sep)) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}
