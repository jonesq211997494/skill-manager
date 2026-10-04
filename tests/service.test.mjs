import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagerService } from '../core/service.mjs';
import { SourceError } from '../core/sources.mjs';
import { serializeError } from '../core/errors.mjs';
import { buildManifest } from '../core/scanner.mjs';

async function writeSkill(directory, revision = 1) {
  await fs.mkdir(path.join(directory, 'references'), { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), '---\nname: safe-skill\ndescription: 集成测试技能\n---\n# 安全技能\n正文版本 ' + revision + '\n');
  await fs.writeFile(path.join(directory, 'references', 'version.txt'), String(revision));
  await fs.writeFile(path.join(directory, 'script.mjs'), 'throw new Error("This skill must never be executed");\n');
}

async function fixture(t) {
  // Windows 临时目录可能使用 8.3 短路径；夹具统一采用同一实体的真实路径。
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-service-test-')));
  const rootIdentity = await fs.stat(root, { bigint: true });
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'app-data');
  const sourcePath = path.join(root, 'original', 'safe-skill');
  const codex = path.join(home, '.codex');
  const claude = path.join(home, '.claude');
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = codex;
  process.env.CLAUDE_CONFIG_DIR = claude;
  await fs.mkdir(codex, { recursive: true });
  await fs.mkdir(claude, { recursive: true });
  await writeSkill(sourcePath);
  const config = '# Keep this config intact\n[[skills.config]]\npath = ' + JSON.stringify(sourcePath) + '\nenabled = false\n';
  await fs.writeFile(path.join(codex, 'config.toml'), config);
  const progress = [];
  const auth = {status:async()=>({authenticated:true,user:{id:123,login:'test-user'},storageAvailable:true}),getCredential:async()=>({token:'test-only-fixture-token',cacheKey:'test-user-fixture'})};
  const manager = new ManagerService({ dataDir, home, auth, onProgress: event => progress.push(event), fetchImpl: () => { throw new Error('Real network is forbidden in service tests'); } });
  t.after(async () => {
    manager.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // 清理前复核真实路径、临时目录边界及原始目录实体，拒绝跟随被替换的入口。
    const resolved = await fs.realpath(root);
    assert.equal(resolved, root);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(root).startsWith('skill-manager-service-test-'));
    const identity = await fs.stat(root, { bigint: true });
    assert.equal(identity.dev, rootIdentity.dev);
    assert.equal(identity.ino, rootIdentity.ino);
    await fs.rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  for (const registered of manager.store.all('roots')) manager.store.delete('roots', registered.id);
  await manager.call('roots.add', { path: path.dirname(sourcePath), tools: ['codex'], scope: 'user' });
  let revision = 1;
  let stale = false;
  let downloads = 0;
  const repository = { id: 321, fullName: 'mock/skills', url: 'https://github.com/mock/skills', defaultBranch: 'main' };
  const remotePaths = { 1: path.join(dataDir, 'staging', 'source-random-a'), 2: path.join(dataDir, 'staging', 'source-random-b') };
  await writeSkill(remotePaths[1], 1);
  await writeSkill(remotePaths[2], 2);
  const candidate = () => ({ name: 'safe-skill', path: 'skills/safe-skill', repository, ref: 'main', commit: String(revision).repeat(40) });
  manager.sources = {
    search: async (query, page) => ({ items: [{ id: repository.id, name: 'skills', fullName: repository.fullName, url: repository.url }], page: page || 1, total: 1, stale: false }),
    inspect: async () => ({ repository, ref: 'main', commit: String(revision).repeat(40), skills: [candidate()], stale }),
    download: async () => {
      downloads++;
      const manifest = await buildManifest(remotePaths[revision]);
      return { path: remotePaths[revision], files: manifest.files, bytes: manifest.bytes, source: { repositoryId: repository.id, fullName: repository.fullName, url: repository.url, ref: 'main', commit: String(revision).repeat(40), subdir: 'skills/safe-skill' } };
    },
  };
  return { manager, root, home, dataDir, sourcePath, progress, config, codex, remotePaths, candidate,
    setRevision: value => { revision = value; }, setStale: value => { stale = value; }, downloads: () => downloads };
}

async function previewInstall(manager, candidate) {
  const preview = await manager.call('sources.preview', { candidate });
  const plan = await manager.call('operations.plan', { kind: 'install', name: preview.skill.name, sourcePath: preview.path, source: preview.source, targets: [{ tool: 'codex', scope: 'user' }] });
  assert.deepEqual(plan.blockers, []);
  return { preview, plan };
}

test('ManagerService 完成本地扫描、组织、在线预览、安装、更新、恢复和迁移闭环', async t => {
  const f = await fixture(t);
  const scanned = await f.manager.call('scan');
  assert.equal(scanned.skills.length, 1);
  const original = scanned.skills[0];
  assert.equal(original.configState, 'disabled');
  await f.manager.call('skills.organize', { id: original.id, alias: '本地研究助手', tags: ['科研'], favorite: true });
  const details = await f.manager.call('skills.detail', { id: original.id });
  assert.equal(details.alias, '本地研究助手');
  assert.equal(details.manifest.complete, true);
  assert.ok(details.manifest.files.some(file => file.path === 'references/version.txt'));
  assert.ok(details.raw.includes('正文版本 1'));
  assert.equal((await f.manager.call('sources.search', { query: 'skills', page: 1 })).total, 1);
  const { preview, plan } = await previewInstall(f.manager, f.candidate());
  assert.equal(preview.skill.name, 'safe-skill');
  const operation = await f.manager.call('operations.execute', { planId: plan.id, digest: plan.digest });
  assert.equal(operation.status, 'completed');
  const installation = f.manager.engine.deployments()[0];
  assert.equal(await fs.readFile(path.join(installation.targetPath, 'references', 'version.txt'), 'utf8'), '1');
  let state = await f.manager.call('bootstrap');
  const installed = state.skills.find(skill => skill.deployments.some(item => item.id === installation.id));
  assert.ok(installed);
  await f.manager.call('skills.organize', { id: installed.id, alias: '已安装的中文别名', tags: ['持续保留'], favorite: true });
  const current = await f.manager.call('updates.check');
  assert.equal(current[0].status, 'current');
  f.setRevision(2);
  const changed = await f.manager.call('updates.check');
  assert.equal(changed[0].status, 'available');
  assert.equal(changed[0].localChanged, false);
  assert.equal(changed[0].remoteChanged, true);
  const updatePlan = await f.manager.call('operations.plan', { kind: 'update', deploymentId: installation.id, sourcePath: changed[0].remotePath, source: changed[0].source });
  assert.deepEqual(updatePlan.blockers, []);
  const updated = await f.manager.call('operations.execute', { planId: updatePlan.id, digest: updatePlan.digest });
  assert.equal(updated.status, 'completed');
  assert.equal(await fs.readFile(path.join(installation.targetPath, 'references', 'version.txt'), 'utf8'), '2');
  state = await f.manager.call('bootstrap');
  const afterUpdate = state.skills.find(skill => skill.deployments.some(item => item.id === installation.id));
  assert.equal(afterUpdate.id, installed.id);
  assert.equal(afterUpdate.alias, '已安装的中文别名');
  assert.deepEqual(afterUpdate.tags, ['持续保留']);
  assert.equal(afterUpdate.favorite, true);
  const restorePlan = await f.manager.call('operations.plan', { kind: 'restore', operationId: updated.id });
  assert.deepEqual(restorePlan.blockers, []);
  const restored = await f.manager.call('operations.execute', { planId: restorePlan.id, digest: restorePlan.digest });
  assert.equal(restored.status, 'completed');
  assert.equal(await fs.readFile(path.join(installation.targetPath, 'references', 'version.txt'), 'utf8'), '1');
  const migrationPath = path.join(f.root, 'skills_inventory.json');
  await fs.writeFile(migrationPath, JSON.stringify({ skills: [{ name: 'safe-skill', path: f.sourcePath, alias: '旧别名' }] }));
  const migration = await f.manager.call('migration.preview', { path: migrationPath });
  assert.equal((await f.manager.call('migration.import', { id: migration.id })).summary.matched, 1);
  assert.equal((await f.manager.call('migration.import', { id: migration.id })).alreadyImported, true);
  assert.equal((await f.manager.call('skills.detail', { id: original.id })).alias, '本地研究助手');
  assert.equal(await fs.readFile(path.join(f.codex, 'config.toml'), 'utf8'), f.config);
  assert.equal((await f.manager.call('operations.history')).length, 3);
  assert.ok(f.progress.length > 0);
  assert.ok(f.progress.every((event, i) => i === 0 || event.sequence > f.progress[i - 1].sequence));
});

test('在线安装目录使用技能名称，不使用临时目录随机后缀', async t => {
  const f = await fixture(t);
  const { plan } = await previewInstall(f.manager, f.candidate());
  assert.equal(path.basename(plan.steps[0].targetPath), 'safe-skill');
});

test('父目录扫描排除应用缓存和恢复快照，保留集中技能库', async t => {
  const f = await fixture(t);
  await writeSkill(path.join(f.dataDir, 'backups', 'fake-history'));
  await writeSkill(path.join(f.dataDir, 'cache', 'fake-cache'));
  await writeSkill(path.join(f.dataDir, 'library', 'retained-skill'));
  for (const registered of f.manager.store.all('roots')) f.manager.store.delete('roots', registered.id);
  await f.manager.call('roots.add', { path: f.root, tools: [] });
  const result = await f.manager.call('scan');
  assert.equal(result.skills.some(skill => skill.physicalPath.startsWith(path.join(f.dataDir, 'backups'))), false);
  assert.equal(result.skills.some(skill => skill.physicalPath.startsWith(path.join(f.dataDir, 'cache'))), false);
  assert.equal(result.skills.some(skill => skill.physicalPath.startsWith(path.join(f.dataDir, 'staging'))), false);
  assert.equal(result.skills.some(skill => skill.physicalPath.startsWith(path.join(f.dataDir, 'library'))), true);
});

test('过期在线索引不会当作最新版本，固定版本不触发下载', async t => {
  const f = await fixture(t);
  const { plan } = await previewInstall(f.manager, f.candidate());
  await f.manager.call('operations.execute', { planId: plan.id, digest: plan.digest });
  f.setStale(true);
  const before = f.downloads();
  const results = await f.manager.call('updates.check');
  assert.equal(results[0].status, 'source-unavailable');
  assert.equal(f.downloads(), before);
  const state = await f.manager.call('bootstrap');
  const installed = state.skills.find(skill => skill.deployments.length);
  await f.manager.call('skills.organize', { id: installed.id, pinned: true });
  const pinned = await f.manager.call('updates.check');
  assert.equal(pinned[0].status, 'pinned');
  assert.equal(f.downloads(), before);
});

test('详情不会读取指向技能包以外的 SKILL.md 符号链接', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside-secret.txt');
  await fs.writeFile(outside, 'outside material must not be rendered');
  await fs.unlink(path.join(f.sourcePath, 'SKILL.md'));
  try { await fs.symlink(outside, path.join(f.sourcePath, 'SKILL.md'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前系统不允许创建文件符号链接'); return; } throw error; }
  const scanned = await f.manager.call('scan');
  const skill = scanned.skills.find(item => item.physicalPath === f.sourcePath);
  assert.ok(skill);
  const result = await f.manager.call('skills.detail', { id: skill.id }).catch(error => ({ error }));
  assert.ok(result.error || !String(result.raw).includes('outside material'));
});

test('限流重置时间与引用歧义经 IPC 错误序列化后仍可用于界面', () => {
  const reset = '2026-10-03T04:00:00Z';
  assert.equal(serializeError(new SourceError('RATE_LIMITED', '限流', { reset })).details.reset, reset);
  const candidates = [{ ref: 'main/feature', path: 'skill' }, { ref: 'main', path: 'feature/skill' }];
  assert.deepEqual(serializeError(new SourceError('AMBIGUOUS_REF', '选择引用', { candidates })).details.candidates, candidates);
});

test('更新检查拒绝旧 URL 被不同仓库身份复用，不建立新的来源关联', async t => {
  const f = await fixture(t);
  const { plan } = await previewInstall(f.manager, f.candidate());
  await f.manager.call('operations.execute', { planId: plan.id, digest: plan.digest });
  const inspection = f.manager.sources.inspect;
  f.manager.sources.inspect = async (...args) => {
    const result = await inspection(...args);
    return { ...result, repository: { ...result.repository, id: 999 } };
  };
  const before = f.downloads();
  const results = await f.manager.call('updates.check');
  assert.equal(results[0].status, 'source-unavailable');
  assert.equal(results[0].error.code, 'SOURCE_IDENTITY_CHANGED');
  assert.equal(f.downloads(), before);
  assert.equal(f.manager.engine.deployments()[0].source.repositoryId, 321);
});

test('两端修改更新与后续修改恢复均要求显式备份，强制移除仍可恢复', async t => {
  const f = await fixture(t);
  const { plan } = await previewInstall(f.manager, f.candidate());
  await f.manager.call('operations.execute', { planId: plan.id, digest: plan.digest });
  const installation = f.manager.engine.deployments()[0];
  const file = path.join(installation.targetPath, 'references', 'version.txt');
  await fs.writeFile(file, 'local edit before update');
  f.setRevision(2);
  const [update] = await f.manager.call('updates.check');
  assert.equal(update.status, 'both-changed');
  const intent = { kind: 'update', deploymentId: installation.id, sourcePath: update.remotePath, source: update.source };
  const blockedUpdate = await f.manager.call('operations.plan', intent);
  assert.equal(blockedUpdate.blockers[0].code, 'LOCAL_MODIFIED');
  const approvedUpdate = await f.manager.call('operations.plan', { ...intent, force: true });
  assert.deepEqual(approvedUpdate.blockers, []);
  const updated = await f.manager.call('operations.execute', { planId: approvedUpdate.id, digest: approvedUpdate.digest });
  assert.equal(updated.status, 'completed');
  assert.equal(await fs.readFile(path.join(updated.steps[0].snapshotPath, 'references', 'version.txt'), 'utf8'), 'local edit before update');
  await fs.writeFile(file, 'newer edit after update');
  const blockedRestore = await f.manager.call('operations.plan', { kind: 'restore', operationId: updated.id });
  assert.equal(blockedRestore.blockers[0].code, 'LOCAL_MODIFIED');
  const restorePlan = await f.manager.call('operations.plan', { kind: 'restore', operationId: updated.id, force: true });
  assert.deepEqual(restorePlan.blockers, []);
  const restored = await f.manager.call('operations.execute', { planId: restorePlan.id, digest: restorePlan.digest });
  assert.equal(restored.status, 'completed');
  assert.equal(await fs.readFile(file, 'utf8'), 'local edit before update');
  assert.equal(await fs.readFile(path.join(restored.steps[0].snapshotPath, 'references', 'version.txt'), 'utf8'), 'newer edit after update');
  const blockedRemove = await f.manager.call('operations.plan', { kind: 'remove', deploymentId: installation.id });
  assert.equal(blockedRemove.blockers[0].code, 'LOCAL_MODIFIED');
  const removePlan = await f.manager.call('operations.plan', { kind: 'remove', deploymentId: installation.id, force: true });
  assert.deepEqual(removePlan.blockers, []);
  const removed = await f.manager.call('operations.execute', { planId: removePlan.id, digest: removePlan.digest });
  assert.equal(removed.status, 'completed');
  await assert.rejects(fs.stat(installation.targetPath), error => error.code === 'ENOENT');
  assert.equal(await fs.readFile(path.join(removed.steps[0].snapshotPath, 'references', 'version.txt'), 'utf8'), 'local edit before update');
  const undoPlan = await f.manager.call('operations.plan', { kind: 'restore', operationId: removed.id });
  assert.deepEqual(undoPlan.blockers, []);
  const undone = await f.manager.call('operations.execute', { planId: undoPlan.id, digest: undoPlan.digest });
  assert.equal(undone.status, 'completed');
  assert.equal(await fs.readFile(file, 'utf8'), 'local edit before update');
});
