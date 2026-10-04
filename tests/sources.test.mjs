import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SourceService, parseGitHubUrl } from '../core/sources.mjs';

const commit = 'a'.repeat(40);
const root = 'b'.repeat(40);
const subtree = 'c'.repeat(40);
const nested = 'd'.repeat(40);
const repo = { id: 123, name: 'skills', full_name: 'owner/skills', html_url: 'https://github.com/owner/skills', default_branch: 'main' };
function blob(name, content, mode = '100644') {
  const buffer = Buffer.from(content);
  return { path: name, type: 'blob', mode, size: buffer.length,
    sha: createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex'), content: buffer };
}
function json(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers }); }
async function setup(t, handler, limits) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-source-test-'));
  t.after(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });
  const calls = [];
  const service = new SourceService({ dataDir, limits, fetchImpl: async (url, options) => {
    calls.push(url);
    return handler(new URL(url), options);
  } });
  return { service, calls, dataDir };
}
function apiHandler({ entries, references = { main: commit }, treeResponses = {} }) {
  return url => {
    const endpoint = decodeURIComponent(url.pathname);
    if (endpoint === '/repos/owner/skills') return json(repo);
    if (endpoint.startsWith('/repos/owner/skills/commits/')) {
      const ref = endpoint.slice('/repos/owner/skills/commits/'.length);
      return references[ref] || ref === commit ? json({ sha: references[ref] || commit, commit: { tree: { sha: root } } }) : json({ message: 'Not Found' }, 404);
    }
    if (endpoint.startsWith('/repos/owner/skills/git/trees/')) {
      const sha = endpoint.split('/').at(-1);
      const key = `${sha}${url.search}`;
      if (treeResponses[key]) return json(treeResponses[key]);
      if (sha === root && !url.search) return json({ tree: [{ path: 'one', type: 'tree', mode: '040000', sha: subtree }] });
      if (sha === subtree || sha === root) return json({ tree: entries.map(({ content, ...entry }) => entry), truncated: false });
    }
    if (endpoint.startsWith('/repos/owner/skills/git/blobs/')) {
      const entry = entries.find(item => item.sha === endpoint.split('/').at(-1));
      if (entry) return new Response(entry.content);
    }
    throw new Error(`Unexpected mock endpoint: ${url}`);
  };
}
function candidate(extra = {}) {
  return { repository: { id: repo.id, fullName: repo.full_name, url: repo.html_url }, ref: 'main', commit, path: 'one', name: 'one', ...extra };
}

test('链接支持仓库、目录与 SKILL.md，并阻止越界及凭据', () => {
  assert.equal(parseGitHubUrl('https://github.com/owner/skills.git').fullName, 'owner/skills');
  assert.equal(parseGitHubUrl('https://github.com/owner/skills/tree/feature%2Fnew/one').tail, 'feature/new/one');
  assert.equal(parseGitHubUrl('https://github.com/owner/skills/blob/main/one/SKILL.md').kind, 'blob');
  for (const bad of [
    'https://example.com/owner/skills', 'http://github.com/owner/skills',
    'https://user:secret@github.com/owner/skills', 'https://github.com/owner/skills/tree/main/../escape',
    'https://github.com/owner/skills/tree/main/%2e%2e/escape', 'https://github.com/owner/skills/blob/main/file.js',
  ]) assert.throws(() => parseGitHubUrl(bad), error => ['INVALID_SOURCE_URL', 'UNSAFE_PATH'].includes(error.code));
});

test('仓库搜索缓存能在断网时回退，并明确标记过期', async t => {
  let offline = false;
  const { service, calls, dataDir } = await setup(t, () => {
    if (offline) throw new Error('offline');
    return json({ items: [{ ...repo, description: '技能仓库', stargazers_count: 12, owner: { login: 'owner' } }], total_count: 1 });
  });
  const first = await service.search('中文技能', 2);
  assert.equal(first.items[0].fullName, 'owner/skills');
  assert.equal(first.page, 2);
  assert.equal(first.stale, false);
  assert.match(calls[0], /is%3Apublic/);
  offline = true;
  const cached = await service.search('中文技能', 2, { forceRefresh: true });
  assert.equal(cached.stale, true);
  assert.equal(cached.cachedAt, first.cachedAt);
  assert.equal(cached.warningCode, 'SOURCE_UNAVAILABLE');
  assert.match(cached.warning, /缓存/);
  assert.equal((await fs.readdir(path.join(dataDir, 'cache'))).length, 1);
});

test('限流响应返回稳定错误码和重置时间', async t => {
  const { service } = await setup(t, () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791000000' }));
  await assert.rejects(service.search('skills'), error => error.code === 'RATE_LIMITED' && error.reset === new Date(1791000000000).toISOString());
});

test('斜杠分支通过 API 核验，不按首个斜杠猜测', async t => {
  const { service } = await setup(t, apiHandler({ entries: [blob('SKILL.md', 'hello')], references: { 'feature/new': commit } }));
  const result = await service.inspect('https://github.com/owner/skills/tree/feature/new/one');
  assert.equal(result.ref, 'feature/new');
  assert.equal(result.commit, commit);
  assert.equal(result.skills[0].path, 'one');
  assert.equal(result.repository.id, repo.id);
});

test('引用歧义要求明确选择，显式引用可解析 blob 链接', async t => {
  const { service } = await setup(t, apiHandler({ entries: [blob('SKILL.md', 'hello')], references: { 'feature/new': commit, feature: commit } }));
  await assert.rejects(service.inspect('https://github.com/owner/skills/tree/feature/new/one'), error => error.code === 'AMBIGUOUS_REF' && error.candidates.length === 2);
  const result = await service.inspect('https://github.com/owner/skills/blob/feature/new/one/SKILL.md', { ref: 'feature/new' });
  assert.equal(result.skills[0].path, 'one');
});

test('递归树被截断时逐层重新获取完整树', async t => {
  const skill = blob('SKILL.md', 'nested skill');
  const { service, calls } = await setup(t, apiHandler({ entries: [skill], treeResponses: {
    [`${root}?recursive=1`]: { truncated: true, tree: [] },
    [root]: { truncated: false, tree: [{ path: 'one', type: 'tree', mode: '040000', sha: subtree }] },
    [subtree]: { truncated: false, tree: [{ path: 'two', type: 'tree', mode: '040000', sha: nested }] },
    [nested]: { truncated: false, tree: [{ ...skill, content: undefined }] },
  } }));
  const result = await service.inspect(repo.html_url);
  assert.deepEqual(result.skills.map(item => item.path), ['one/two']);
  assert.equal(calls.some(url => url.endsWith(`/git/trees/${nested}`)), true);
});

test('只下载选定技能目录并逐文件验证 Git 摘要', async t => {
  const entries = [blob('SKILL.md', '---\nname: one\n---\n正文'), blob('references/研究.txt', '中文附件')];
  const { service, calls } = await setup(t, apiHandler({ entries }));
  const progress = [];
  const result = await service.download(candidate(), { onProgress: event => progress.push(event) });
  assert.equal(await fs.readFile(path.join(result.path, 'references', '研究.txt'), 'utf8'), '中文附件');
  assert.equal(result.source.subdir, 'one');
  assert.equal(result.source.commit, commit);
  assert.equal(result.files.length, 2);
  assert.equal(progress.at(-1).files, 2);
  assert.equal(calls.some(url => url.includes(`${root}?recursive`)), false);
  assert.equal(calls.filter(url => url.includes('/git/blobs/')).length, 2);
});

test('越界、Windows 保留名、大小写冲突、链接与子模块均在写入前拒绝', async t => {
  const badEntries = [
    [blob('../escape', 'x')], [blob('CON.txt', 'x')], [blob('a./x', 'x')], [blob('C:/escape', 'x')],
    [blob('Readme.md', 'x'), blob('README.md', 'x')], [blob('Dir/x', 'x'), blob('dir/y', 'x')],
    [blob('link', 'outside', '120000')], [{ path: 'module', type: 'commit', mode: '160000', sha: commit }],
  ];
  for (const entries of badEntries) {
    const { service, dataDir, calls } = await setup(t, apiHandler({ entries: [blob('SKILL.md', 'skill'), ...entries] }));
    await assert.rejects(service.download(candidate()), error => ['UNSAFE_PATH', 'PATH_CASE_CONFLICT', 'UNSAFE_ENTRY'].includes(error.code));
    assert.equal(calls.some(url => url.includes('/git/blobs/')), false);
    assert.deepEqual(await fs.readdir(dataDir), []);
  }
});

test('预算限制与不完整包拒绝安装', async t => {
  const { service } = await setup(t, apiHandler({ entries: [blob('SKILL.md', 'too big')] }), { fileBytes: 2 });
  await assert.rejects(service.download(candidate()), error => error.code === 'SOURCE_LIMIT');
  const missing = await setup(t, apiHandler({ entries: [blob('README.md', 'not a skill')] }));
  await assert.rejects(missing.service.download(candidate()), error => error.code === 'INVALID_SKILL_PACKAGE');
});

test('远端内容不符时移除受控暂存包', async t => {
  const handler = apiHandler({ entries: [blob('SKILL.md', 'trusted')] });
  const { service, dataDir } = await setup(t, url => url.pathname.includes('/git/blobs/') ? new Response('changed') : handler(url));
  await assert.rejects(service.download(candidate()), error => error.code === 'SOURCE_INTEGRITY');
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'staging')), []);
});

test('流式响应大小超限时停止读取', async t => {
  const { service } = await setup(t, () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(200)); controller.close();
  } })), { responseBytes: 100 });
  await assert.rejects(service.search('skills'), error => error.code === 'SOURCE_LIMIT');
});

test('取消不会返回过期缓存', async t => {
  const { service } = await setup(t, apiHandler({ entries: [blob('SKILL.md', 'skill')] }));
  await service.inspect(repo.html_url);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(service.inspect(repo.html_url, { signal: abort.signal }), error => error.code === 'CANCELLED');
});

test('仓库重定向只允许 GitHub API，并复核安装来源身份', async t => {
  const handler = apiHandler({ entries: [blob('SKILL.md', 'skill')] });
  const { service } = await setup(t, url => url.pathname === '/repos/old/skills'
    ? new Response(null, { status: 301, headers: { location: 'https://api.github.com/repos/owner/skills' } }) : handler(url));
  const result = await service.inspect('https://github.com/old/skills');
  assert.equal(result.repository.url, repo.html_url);
  await assert.rejects(service.download(candidate({ repository: { id: 999, url: repo.html_url } })), error => error.code === 'SOURCE_IDENTITY_CHANGED');
  const bad = await setup(t, () => new Response(null, { status: 302, headers: { location: 'https://example.com/private' } }));
  await assert.rejects(bad.service.search('skills'), error => error.code === 'SOURCE_INVALID');
});
