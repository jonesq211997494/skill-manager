import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { IPC_METHODS, parseIpcArgs } from '../core/ipc-contracts.mjs';

const localPath = path.resolve('contract-fixture', 'skill');
const candidate = { name: 'sample', path: 'skills/sample', repository: { id: 7, fullName: 'owner/repo', url: 'https://github.com/owner/repo' }, ref: 'main', commit: 'a'.repeat(40) };
const invalid = (method, args, code = 'INVALID_ARGUMENT') => assert.throws(() => parseIpcArgs(method, args), { code });

test('每个服务方法都登记参数契约，未知方法使用稳定错误码', async () => {
  const service = await fs.readFile(new URL('../core/service.mjs', import.meta.url), 'utf8');
  const methods = [...service.matchAll(/case '([^']+)'/g)].map(match => match[1]);
  for (const method of methods) assert.ok(IPC_METHODS.includes(method), method);
  for (const method of ['unknown', '__proto__', 'constructor', null, 1]) invalid(method, {}, 'UNKNOWN_METHOD');
  assert.deepEqual(parseIpcArgs('bootstrap'), {});
});

test('入口拒绝数组、非普通对象、未知字段和缺失必填字段', () => {
  for (const value of [[], ['id'], null, true, 'text', 42, new Date(), Object.create({ id: 'x' })]) invalid('bootstrap', value);
  invalid('bootstrap', { extra: true });
  for (const method of ['skills.detail', 'roots.remove', 'projects.remove', 'sources.remove', 'operations.status', 'operations.refresh', 'migration.import', 'skills.source.bind']) invalid(method, {});
  invalid('skills.detail', { id: 'x', untrusted: true });
  invalid('skills.detail', { id: ' ' });
  invalid('skills.detail', { id: 'x'.repeat(257) });
  invalid('skills.detail', JSON.parse('{"id":"x","__proto__":{"polluted":true}}'));
});

test('整理字段拒绝超长文本、混合标签和伪布尔值，保留有效中文', () => {
  invalid('skills.organize', { id: 'x', alias: 'a'.repeat(201) });
  invalid('skills.organize', { id: 'x', tags: ['正常', 42] });
  invalid('skills.organize', { id: 'x', tags: Array(51).fill('标签') });
  invalid('skills.organize', { id: 'x', tags: ['a'.repeat(51)] });
  for (const field of ['favorite', 'pinned']) for (const value of ['false', 0, null]) invalid('skills.organize', { id: 'x', [field]: value });
  const input = { id: 'x', alias: '中文别名', tags: ['科研'], favorite: false, pinned: true };
  const parsed = parseIpcArgs('skills.organize', input);
  assert.deepEqual(parsed, input);
  parsed.tags.push('另一个');
  assert.deepEqual(input.tags, ['科研'], '契约返回独立数组，不修改客户端对象');
});

test('设置数值严格使用有限 number，整份设置中的只读项目列表被剥离', () => {
  for (const field of ['fontSize', 'backupDays', 'backupMinimum', 'backupLimitGB']) {
    for (const value of ['30', NaN, Infinity, -1, 0, true, null]) invalid('settings.save', { [field]: value });
  }
  invalid('settings.save', { theme: 'neon' });
  invalid('settings.save', { fontSize: 21 });
  invalid('settings.save', { backupDays: 1.2 });
  invalid('settings.save', { backupMinimum: 1.2 });
  invalid('settings.save', { proxy: 'http://user:password@localhost:7890' });
  invalid('settings.save', { proxy: 'file:///tmp/proxy' });
  invalid('settings.save', { projects: 'wrong' });
  invalid('settings.save', { typo: true });
  const settings = { theme: 'system', fontSize: 14, libraryPath: localPath, proxy: '', backupDays: 30, backupMinimum: 3, backupLimitGB: 0.5 };
  assert.deepEqual(parseIpcArgs('settings.save', { ...settings, projects: [{ id: 'project', path: localPath, name: '项目' }] }), settings);
});

test('路径字段拒绝空白、控制字符、相对路径和 Windows 非法文件名', () => {
  for (const value of ['', ' ', '../escape', 'C:relative', 'bad\0path', 'C:\\bad|path', 'C:\\CON', 'C:\\bad.']) {
    for (const method of ['roots.add', 'projects.add', 'migration.preview', 'files.open']) invalid(method, { path: value });
  }
  for (const value of ['../secret', '/absolute', 'C:\\secret', 'a/../b', 'a\\b', 'CON']) invalid('files.compare', { deploymentId: 'x', relativePath: value });
  assert.deepEqual(parseIpcArgs('files.open', { path: localPath }), { path: localPath });
  if (process.platform === 'win32') {
    for (const value of ['\\rooted', '/rooted', '\\\\server', '\\\\bad|server\\share']) invalid('files.open', { path: value });
    assert.deepEqual(parseIpcArgs('files.open', { path: '\\\\server\\share\\skill' }), { path: '\\\\server\\share\\skill' });
  }
});

test('方法枚举、分页和数组预算显式校验', () => {
  invalid('roots.add', { path: localPath, kind: 'unknown' });
  invalid('roots.add', { path: localPath, tools: ['unknown'] });
  invalid('roots.add', { path: localPath, tools: Array(4).fill('codex') });
  invalid('jobs.cancel', { id: 'operation' });
  invalid('updates.check', { skillIds: Array(1001).fill('x') });
  invalid('updates.check', { skillIds: [false] });
  invalid('updates.check', { tool: 'unknown' });
  for (const page of [0, -1, 1.5, NaN, '1', 1001]) invalid('sources.search', { query: 'skills', page });
  invalid('sources.search', { query: 'a'.repeat(501) });
  invalid('sources.inspect', { url: 'https://github.com/owner/repo', forceRefresh: 'false' });
  assert.deepEqual(parseIpcArgs('updates.check', { tool: 'all', scope: 'all', skillIds: [] }), { tool: 'all', scope: 'all', skillIds: [] });
});

test('来源候选固定提交并检查仓库、路径，忽略合法的界面展示字段', () => {
  invalid('sources.preview', { candidate: {} });
  invalid('sources.preview', { candidate: { ...candidate, commit: 'main' } });
  invalid('sources.preview', { candidate: { ...candidate, path: '../secret' } });
  invalid('sources.preview', { candidate: { ...candidate, repository: { url: 'https://example.com/repo' } } });
  invalid('sources.preview', { candidate: { ...candidate, repository: { ...candidate.repository, id: NaN } } });
  invalid('sources.preview', { candidate: { ...candidate, surprise: true } });
  const display = { ...candidate, id: '7:skills/sample', url: 'https://github.com/owner/repo/tree/main/skills/sample', stale: false, fromCache: true, cachedAt: '2026-10-04T00:00:00Z', warning: undefined, repository: { ...candidate.repository, defaultBranch: 'main', license: { name: 'MIT', spdxId: 'MIT', url: null } } };
  const parsed = parseIpcArgs('sources.preview', { candidate: display }).candidate;
  assert.equal(parsed.commit, candidate.commit);
  assert.equal(parsed.path, candidate.path);
  assert.equal(parsed.repository.id, 7);
  assert.equal('stale' in parsed, false);
  assert.equal('license' in parsed.repository, false);
});

test('操作计划按类型要求字段，兼容界面共用对话框的空 targets 与展示 name', () => {
  for (const args of [{ kind: 'unknown' }, { kind: 'install', targets: [{ tool: 'codex', scope: 'user' }] }, { kind: 'import', skillIds: [] }, { kind: 'remove' }, { kind: 'update', deploymentId: 'x' }, { kind: 'restore' }]) invalid('operations.plan', args);
  invalid('operations.plan', { kind: 'install', sourcePath: localPath, targets: [{ tool: 'unknown', scope: 'user' }] });
  invalid('operations.plan', { kind: 'remove', deploymentId: 'x', force: 'true' });
  invalid('operations.plan', { kind: 'install', sourcePath: localPath, skillIds: ['x'], targets: [{ tool: 'codex', scope: 'user' }] });
  invalid('operations.plan', { kind: 'install', sourcePath: localPath, targets: [] });
  invalid('operations.plan', { kind: 'install', sourcePath: localPath, targets: Array(101).fill({ tool: 'codex', scope: 'user' }) });
  assert.deepEqual(parseIpcArgs('operations.plan', { kind: 'remove', deploymentId: 'x', name: '个人显示名', force: false, targets: [] }), { kind: 'remove', deploymentId: 'x', name: '个人显示名', force: false, targets: [] });
  assert.deepEqual(parseIpcArgs('operations.plan', { kind: 'import', skillIds: ['x'], name: '中文别名 / 展示', targets: [], force: false }), { kind: 'import', skillIds: ['x'], name: '中文别名 / 展示', targets: [], force: false });
});

test('文件对比必须且只能选择一个跟踪对象，网页和登录输入有明确约束', () => {
  invalid('files.compare', {});
  invalid('files.compare', { deploymentId: 'x', bindingId: 'y' });
  invalid('links.open', { url: 'javascript:alert(1)' });
  invalid('links.open', { url: 'http://user:secret@example.com' });
  invalid('sources.add', { url: 'https://github.com' });
  invalid('github.loginToken', { token: 'x'.repeat(1025) });
  invalid('github.loginBrowser', { username: 'x'.repeat(40) });
  const args = parseIpcArgs('sources.inspect', { url: 'https://github.com/owner/repo', ref: undefined });
  assert.deepEqual(args, { url: 'https://github.com/owner/repo' });
});
