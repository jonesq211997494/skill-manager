import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SourceService } from '../core/sources.mjs';

const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const repo = { id: 123, name: 'skills', full_name: 'owner/skills', html_url: 'https://github.com/owner/skills', default_branch: 'main' };
const candidate = { repository: { id: repo.id, url: repo.html_url }, commit, ref: 'main', path: '' };
const accountA = { token: 'test-token-a', cacheKey: 'github:1' };
const accountB = { token: 'test-token-b', cacheKey: 'github:2' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const gitHash = content => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
function entry(name, content) {
  const buffer = Buffer.from(content);
  return { path: name, mode: '100644', type: 'blob', size: buffer.length, sha: gitHash(buffer), content: buffer };
}
const files = [entry('SKILL.md', 'trusted skill'), entry('references/file.txt', 'trusted reference')];
function handler(url) {
  if (url.pathname === '/search/repositories') return json({ items: [repo], total_count: 1 });
  if (url.pathname === '/repos/owner/skills') return json(repo);
  if (url.pathname.startsWith('/repos/owner/skills/commits/')) return json({ sha: commit, commit: { tree: { sha: tree } } });
  if (url.pathname.startsWith('/repos/owner/skills/git/trees/')) return json({ tree: files.map(({ content, ...item }) => item), truncated: false });
  if (url.pathname.startsWith('/repos/owner/skills/git/blobs/')) {
    const file = files.find(item => url.pathname.endsWith(item.sha));
    if (file) return new Response(file.content);
  }
  throw new Error(`Unexpected endpoint ${url.pathname}`);
}
async function setup(t, { respond = handler, credential = accountA, ...options } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-cache-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (value, config) => {
    calls.push({ url: value, headers: config.headers, signal: config.signal });
    return respond(new URL(value), config);
  };
  const getCredential = options.getCredential || (async () => credential);
  const service = new SourceService({ dataDir, fetchImpl, getCredential, requireAuth: true, ...options });
  return { service, dataDir, calls, fetchImpl, getCredential };
}

test('必须登录时不发出匿名请求', async t => {
  const { service, calls } = await setup(t, { credential: null });
  await assert.rejects(service.search('skills'), error => error.code === 'GITHUB_LOGIN_REQUIRED');
  await assert.rejects(service.inspect(repo.html_url), error => error.code === 'GITHUB_LOGIN_REQUIRED');
  await assert.rejects(service.download(candidate), error => error.code === 'GITHUB_LOGIN_REQUIRED');
  assert.equal(calls.length, 0);
});

test('认证仅发送到 GitHub API，外域重定向不发送 token', async t => {
  const { service, calls } = await setup(t, { respond: () => new Response(null, { status: 302, headers: { location: 'https://outside.example/private' } }) });
  await assert.rejects(service.search('skills'), error => error.code === 'SOURCE_INVALID');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token-a');
  assert.equal(new URL(calls[0].url).origin, 'https://api.github.com');
  await assert.rejects(service._request('https://outside.example/private'), error => error.code === 'SOURCE_INVALID');
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(service.status()).includes('test-token'), false);
});

test('搜索在五分钟内命中缓存，过期与强制刷新重新联网', async t => {
  let now = 1800000000000;
  const { service, calls } = await setup(t, { now: () => now });
  const first = await service.search('skills');
  assert.equal(first.fromCache, false);
  assert.equal(first.refreshAfter, new Date(now + 300000).toISOString());
  first.items[0].name = 'changed by renderer';
  const cached = await service.search('skills');
  assert.equal(cached.fromCache, true);
  assert.equal(cached.items[0].name, repo.name);
  assert.equal(calls.length, 1);
  now += 300001;
  assert.equal((await service.search('skills')).fromCache, false);
  assert.equal(calls.length, 2);
  await service.search('skills', 1, { forceRefresh: true });
  assert.equal(calls.length, 3);
});

test('重复并发搜索只进行一次远程请求', async t => {
  const { service, calls } = await setup(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => service.search('skills')));
  assert.equal(calls.length, 1);
  assert.equal(results.length, 8);
});

test('inspect 复用缓存，刷新仍复核仓库身份与分支但复用固定文件树', async t => {
  const { service, calls, dataDir, fetchImpl, getCredential } = await setup(t);
  const results = await Promise.all([service.inspect(repo.html_url), service.inspect(repo.html_url)]);
  assert.equal(calls.length, 3);
  assert.equal(results[0].commit, commit);
  await service.inspect(repo.html_url);
  assert.equal(calls.length, 3);
  await service.inspect(repo.html_url, { forceRefresh: true });
  assert.equal(calls.length, 5);
  assert.equal(calls.filter(item => new URL(item.url).pathname === '/repos/owner/skills').length, 2);
  const restarted = new SourceService({ dataDir, fetchImpl, getCredential, requireAuth: true });
  assert.equal((await restarted.inspect(repo.html_url)).fromCache, true);
  assert.equal(calls.length, 5);
});

test('重复预览和重启均复用完整固定提交包，不发出请求', async t => {
  const { service, calls, dataDir, fetchImpl, getCredential } = await setup(t);
  const first = await service.download(candidate);
  const requestCount = calls.length;
  assert.equal(requestCount, 5);
  const second = await service.download(candidate);
  assert.equal(second.path, first.path);
  assert.equal(second.fromCache, true);
  assert.equal(calls.length, requestCount);
  const restarted = new SourceService({ dataDir, fetchImpl, getCredential, requireAuth: true });
  assert.equal((await restarted.download(candidate)).path, first.path);
  assert.equal(calls.length, requestCount);
});

test('并发重复下载只生成一个完整技能包', async t => {
  const { service, calls } = await setup(t);
  const result = await Promise.all([service.download(candidate), service.download(candidate), service.download(candidate)]);
  assert.equal(new Set(result.map(item => item.path)).size, 1);
  assert.equal(calls.length, 5);
});

test('包中篡改、缺失和额外文件均触发安全重建，复用已校验 blob', async t => {
  const { service, calls } = await setup(t);
  let current = await service.download(candidate);
  for (const tamper of [
    async directory => fs.writeFile(path.join(directory, 'SKILL.md'), 'untrust skill'),
    async directory => fs.rm(path.join(directory, 'references', 'file.txt')),
    async directory => fs.writeFile(path.join(directory, 'extra.txt'), 'extra'),
    async directory => fs.mkdir(path.join(directory, 'extra-empty-directory')),
  ]) {
    await tamper(current.path);
    const rebuilt = await service.download(candidate);
    assert.notEqual(rebuilt.path, current.path);
    assert.equal(rebuilt.fromCache, false);
    assert.equal(await fs.readFile(path.join(rebuilt.path, 'SKILL.md'), 'utf8'), 'trusted skill');
    assert.deepEqual((await fs.readdir(rebuilt.path)).sort(), ['SKILL.md', 'references']);
    current = rebuilt;
  }
  assert.equal(calls.filter(item => item.url.includes('/git/blobs/')).length, 2);
});

test('污染 blob 缓存也必须重新下载且验证 Git 摘要', async t => {
  const { service, calls, dataDir } = await setup(t);
  const first = await service.download(candidate);
  const [scope] = await fs.readdir(path.join(dataDir, 'cache', 'blobs'));
  const blobFile = path.join(dataDir, 'cache', 'blobs', scope, files[0].sha);
  await fs.writeFile(blobFile, 'untrust skill');
  await fs.writeFile(path.join(first.path, 'SKILL.md'), 'untrust skill');
  const rebuilt = await service.download(candidate);
  assert.equal(await fs.readFile(path.join(rebuilt.path, 'SKILL.md'), 'utf8'), 'trusted skill');
  assert.equal(calls.filter(item => item.url.includes('/git/blobs/')).length, 3);
});

test('缓存包内链接不被复用且不会写入链接目标', async t => {
  const { service, dataDir } = await setup(t);
  const first = await service.download(candidate);
  const target = path.join(dataDir, 'outside');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'untouched.txt'), 'untouched');
  try { await fs.symlink(target, path.join(first.path, 'extra-link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('系统禁止创建测试链接'); return; } throw error; }
  const rebuilt = await service.download(candidate);
  assert.notEqual(rebuilt.path, first.path);
  assert.deepEqual(await fs.readdir(target), ['untouched.txt']);
});

test('认证账号与匿名缓存隔离，切换后不复用前一账号的包', async t => {
  let credential = accountA;
  const { service, calls, dataDir, fetchImpl } = await setup(t, { getCredential: async () => credential });
  const firstSearch = await service.search('skills');
  assert.equal(firstSearch.fromCache, false);
  const first = await service.download(candidate);
  const firstCount = calls.length;
  credential = accountB;
  service.resetAuthState();
  assert.equal((await service.search('skills')).fromCache, false);
  const second = await service.download(candidate);
  assert.notEqual(second.path, first.path);
  assert.equal(calls.length, firstCount * 2);
  assert.ok(calls.slice(firstCount).every(item => item.headers.Authorization === 'Bearer test-token-b'));
  const anonymous = new SourceService({ dataDir, fetchImpl });
  assert.equal((await anonymous.search('skills')).fromCache, false);
  assert.equal(calls.at(-1).headers.Authorization, undefined);
  credential = accountA;
  service.resetAuthState();
  assert.equal((await service.download(candidate)).path, first.path);
});

test('401 使当前登录失效且不使用旧缓存或匿名重试', async t => {
  let expire = false;
  let credential = accountA;
  const invalidated = [];
  const { service, calls } = await setup(t, {
    getCredential: async () => credential,
    respond: url => expire ? json({ message: 'Bad credentials' }, 401) : handler(url),
    onUnauthorized: key => { invalidated.push(key); credential = null; service.resetAuthState(); },
  });
  await service.search('skills');
  expire = true;
  await assert.rejects(service.search('skills', 1, { forceRefresh: true }), error => error.code === 'GITHUB_SESSION_EXPIRED');
  assert.deepEqual(invalidated, [accountA.cacheKey]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(item => item.headers.Authorization === 'Bearer test-token-a'));
  await assert.rejects(service.search('skills'), error => error.code === 'GITHUB_LOGIN_REQUIRED');
  assert.equal(calls.length, 2);
});

test('search 配额冷却阻止重复点击，core 配额独立且到期可恢复', async t => {
  let now = 1800000000000;
  let limited = true;
  const { service, calls } = await setup(t, { now: () => now, respond: url => limited && url.pathname.startsWith('/search/')
    ? json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '30', 'x-ratelimit-reset': String((now + 60000) / 1000) })
    : handler(url) });
  await assert.rejects(service.search('skills'), error => error.code === 'RATE_LIMITED' && error.resource === 'search' && error.retryAfter === 60);
  for (let i = 0; i < 5; i++) await assert.rejects(service.search('skills'), error => error.code === 'RATE_LIMITED');
  assert.equal(calls.length, 1);
  assert.equal(service.status().resources.search.remaining, 0);
  await service.inspect(repo.html_url);
  assert.equal(calls.length, 4);
  now += 60001;
  limited = false;
  await service.search('skills');
  assert.equal(calls.length, 5);
});

test('Retry-After 优先于 reset，二级限流同时暂停 core 和 search', async t => {
  let now = 1800000000000;
  let limited = true;
  const { service, calls } = await setup(t, { now: () => now, respond: url => limited
    ? json({ message: 'secondary rate limit' }, 403, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String((now + 3600000) / 1000), 'retry-after': '30' }) : handler(url) });
  await assert.rejects(service.search('skills'), error => error.resource === 'secondary' && error.retryAt === new Date(now + 30000).toISOString());
  await assert.rejects(service.inspect(repo.html_url), error => error.code === 'RATE_LIMITED');
  assert.equal(calls.length, 1);
  assert.equal(service.status().cooldownUntil, new Date(now + 30000).toISOString());
  now += 30001;
  limited = false;
  await service.inspect(repo.html_url);
  assert.equal(calls.length, 4);
});

test('无恢复头的二级限流至少冷却一分钟', async t => {
  const now = 1800000000000;
  const { service, calls } = await setup(t, { now: () => now, respond: () => json({ message: 'secondary rate limit' }, 403) });
  await assert.rejects(service.search('skills'), error => error.retryAfter === 60 && error.resource === 'secondary');
  await assert.rejects(service.inspect(repo.html_url), error => error.code === 'RATE_LIMITED');
  assert.equal(calls.length, 1);
});

test('成功响应消耗最后一次额度后，下一次刷新直接冷却', async t => {
  const now = 1800000000000;
  const { service, calls } = await setup(t, { now: () => now, respond: () => json({ items: [], total_count: 0 }, 200,
    { 'x-ratelimit-resource': 'search', 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 60000) / 1000) }) });
  await service.search('skills');
  const cached = await service.search('skills', 1, { forceRefresh: true });
  assert.equal(cached.warningCode, 'RATE_LIMITED');
  assert.equal(cached.stale, true);
  assert.equal(cached.retryAfter, 60);
  assert.equal(calls.length, 1);
});

test('限流时回退旧缓存包含恢复时间且重复点击不发送请求', async t => {
  let now = 1800000000000;
  let limited = false;
  const { service, calls } = await setup(t, { now: () => now, respond: url => limited ? json({}, 429, { 'retry-after': '45' }) : handler(url) });
  await service.search('skills');
  now += 300001;
  limited = true;
  const cached = await service.search('skills');
  assert.equal(cached.stale, true);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.retryAt, new Date(now + 45000).toISOString());
  await service.search('skills');
  assert.equal(calls.length, 2);
});

test('切换账号会取消在途结果且不留下可复用的旧搜索', async t => {
  let release;
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls } = await setup(t, { respond: async url => { start(); await gate; return handler(url); } });
  const pending = service.search('skills');
  await started;
  service.resetAuthState();
  release();
  await assert.rejects(pending, error => error.code === 'AUTH_CHANGED');
  await service.search('skills');
  assert.equal(calls.length, 2);
});

test('不同在线操作串行发送，避免并发触发 GitHub 二级限流', async t => {
  let active = 0;
  let maximum = 0;
  const { service } = await setup(t, { respond: async url => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return handler(url);
  } });
  await Promise.all([service.search('one'), service.search('two'), service.inspect(repo.html_url), service.download(candidate)]);
  assert.equal(maximum, 1);
});

test('相同提交跨分支复用包时仍保留当前选定引用', async t => {
  const { service, calls, dataDir } = await setup(t);
  const first = await service.download(candidate);
  const requestCount = calls.length;
  const second = await service.download({ ...candidate, ref: 'release' });
  assert.equal(second.path, first.path);
  assert.equal(second.source.ref, 'release');
  const fixed = await service.download({ ...candidate, ref: undefined });
  assert.equal(fixed.source.ref, commit);
  assert.equal(calls.length, requestCount);
  for (const file of await fs.readdir(path.join(dataDir, 'cache', 'packages'))) {
    const stored = await fs.readFile(path.join(dataDir, 'cache', 'packages', file), 'utf8');
    assert.equal(stored.includes(accountA.token), false);
    assert.equal(stored.includes(accountA.cacheKey), false);
  }
});


test('并发下载相同提交的不同分支各自保留更新引用', async t => {
  const { service, calls } = await setup(t);
  const results = await Promise.all([
    service.download(candidate),
    service.download({ ...candidate, ref: 'release' }),
    service.download({ ...candidate, ref: undefined }),
  ]);
  assert.equal(new Set(results.map(item => item.path)).size, 1);
  assert.deepEqual(results.map(item => item.source.ref), ['main', 'release', commit]);
  assert.equal(calls.length, 5);
});
