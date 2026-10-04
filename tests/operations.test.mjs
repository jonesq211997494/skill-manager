import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../core/store.mjs';
import { OperationEngine, compareVersions, fingerprint } from '../core/operations.mjs';
import { buildManifest } from '../core/scanner.mjs';

const exists = async location => fs.access(location).then(() => true, () => false);
const skillText = name => `---\nname: ${name}\ndescription: 用于隔离测试\n---\n# 技能正文\n`;
async function putSkill(folder, contents = '原始脚本') {
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'SKILL.md'), skillText(path.basename(folder)));
  await fs.writeFile(path.join(folder, 'script.txt'), contents);
}
async function setup(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-operation-'));
  const home = path.join(base, 'home');
  const dataDir = path.join(base, 'data');
  const source = path.join(base, 'source', 'example');
  const projects = [path.join(base, 'project-a'), path.join(base, 'project-b')];
  await Promise.all([fs.mkdir(home), ...projects.map(project => fs.mkdir(project)), putSkill(source)]);
  const store = new Store(dataDir);
  for (const project of projects) store.put('projects', project, { id: project, path: project });
  const roots = [];
  const engine = new OperationEngine({ store, dataDir, home, roots: () => roots });
  t.after(async () => {
    try { store.close(); } catch {}
    // 清理范围必须仍是本测试创建的独立临时目录，链接入口由 rm 自身移除。
    const resolved = await fs.realpath(base);
    assert.equal(resolved, path.resolve(base));
    assert.ok(path.basename(base).startsWith('skill-manager-operation-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, home, dataDir, source, projects, store, engine, roots };
}
async function install(context, targets = [{ tool: 'codex', scope: 'user' }]) {
  const plan = await context.engine.plan({ kind: 'install', sourcePath: context.source, targets });
  assert.deepEqual(plan.blockers, []);
  const operation = await context.engine.execute(plan.id, plan.digest);
  assert.equal(operation.status, 'completed', JSON.stringify(operation.steps.map(step => step.error)));
  return operation;
}

test('同一技能安装到用户和两个项目，各范围独立登记并提示共享工具', async t => {
  const f = await setup(t);
  const targets = [{ tool: 'codex', scope: 'user' }, ...f.projects.map(scope => ({ tool: 'codex', scope }))];
  const operation = await install(f, targets);
  assert.equal(operation.steps.length, 3);
  assert.equal(f.engine.deployments().length, 3);
  assert.equal(new Set(f.engine.deployments().map(deployment => deployment.scope)).size, 3);
  assert.ok(operation.steps.every(step => step.tools.includes('cursor')));
  for (const step of operation.steps) {
    assert.equal((await buildManifest(step.targetPath)).hash, step.afterHash);
  }
});

test('执行同一计划的并发重试幂等，不重复建立安装', async t => {
  const f = await setup(t);
  const plan = await f.engine.plan({ kind: 'install', sourcePath: f.source, targets: [{ tool: 'codex', scope: 'user' }] });
  const [first, second] = await Promise.all([f.engine.execute(plan.id, plan.digest), f.engine.execute(plan.id, plan.digest)]);
  assert.equal(first.id, second.id);
  assert.equal(first.status, 'completed');
  assert.equal(f.engine.history().length, 1);
  assert.equal(f.engine.deployments().length, 1);
});

test('预览后来源内容修改导致 PLAN_STALE，目标不写入', async t => {
  const f = await setup(t);
  const plan = await f.engine.plan({ kind: 'install', sourcePath: f.source, targets: [{ tool: 'codex', scope: 'user' }] });
  await fs.writeFile(path.join(f.source, 'script.txt'), '预览之后修改');
  await assert.rejects(f.engine.execute(plan.id, plan.digest), { code: 'PLAN_STALE' });
  assert.equal(await exists(plan.steps[0].targetPath), false);
  assert.equal(f.engine.deployments().length, 0);
});

test('预览后目标的祖先 Junction 改向导致 PLAN_STALE', async t => {
  const f = await setup(t);
  const first = path.join(f.base, 'first-target');
  const second = path.join(f.base, 'second-target');
  await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
  const entrance = path.join(f.home, '.agents');
  await fs.symlink(first, entrance, process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await f.engine.plan({ kind: 'install', sourcePath: f.source, targets: [{ tool: 'codex', scope: 'user' }] });
  assert.deepEqual(plan.blockers, []);
  await fs.unlink(entrance);
  await fs.symlink(second, entrance, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.engine.execute(plan.id, plan.digest), { code: 'PLAN_STALE' });
  assert.equal(await exists(path.join(second, 'skills', 'example')), false);
  assert.equal(await exists(path.join(first, 'skills', 'example')), false);
});

test('插件只读限制作用于执行服务的目标和索引技能', async t => {
  const f = await setup(t);
  const targetRoot = path.join(f.home, '.agents', 'skills');
  await fs.mkdir(targetRoot, { recursive: true });
  f.roots.push({ path: targetRoot, kind: 'plugin', readOnly: true });
  const targetPlan = await f.engine.plan({ kind: 'install', sourcePath: f.source, targets: [{ tool: 'codex', scope: 'user' }] });
  assert.equal(targetPlan.blockers[0].code, 'READ_ONLY_OWNER');
  f.store.put('skills', 'plugin-skill', { id: 'plugin-skill', physicalPath: f.source, management: 'readonly' });
  const sourcePlan = await f.engine.plan({ kind: 'import', skillIds: ['plugin-skill'] });
  assert.equal(sourcePlan.blockers[0].code, 'READ_ONLY_OWNER');
});

test('移除此安装后可恢复完整包和安装关系', async t => {
  const f = await setup(t);
  const installed = await install(f);
  const deployment = f.engine.deployments()[0];
  const removal = await f.engine.plan({ kind: 'remove', deploymentId: deployment.id });
  assert.deepEqual(removal.blockers, []);
  const removed = await f.engine.execute(removal.id, removal.digest);
  assert.equal(removed.status, 'completed');
  assert.equal(await exists(deployment.targetPath), false);
  assert.equal(f.engine.deployments().length, 0);
  const restore = await f.engine.plan({ kind: 'restore', operationId: removed.id });
  assert.deepEqual(restore.blockers, []);
  const restored = await f.engine.execute(restore.id, restore.digest);
  assert.equal(restored.status, 'completed');
  assert.equal((await buildManifest(deployment.targetPath)).hash, installed.steps[0].afterHash);
  assert.equal(f.engine.deployments()[0].id, deployment.id);
});

test('更新拒绝覆盖本地修改，强制选项先保留当前内容的恢复快照', async t => {
  const f = await setup(t);
  await install(f);
  const deployment = f.engine.deployments()[0];
  await fs.writeFile(path.join(deployment.targetPath, 'script.txt'), '用户本地修改');
  await fs.writeFile(path.join(f.source, 'script.txt'), '远端新版本');
  const rejected = await f.engine.plan({ kind: 'update', deploymentId: deployment.id, sourcePath: f.source });
  assert.equal(rejected.blockers[0].code, 'LOCAL_MODIFIED');
  assert.equal(await fs.readFile(path.join(deployment.targetPath, 'script.txt'), 'utf8'), '用户本地修改');
  const plan = await f.engine.plan({ kind: 'update', deploymentId: deployment.id, sourcePath: f.source, force: true });
  assert.deepEqual(plan.blockers, []);
  const operation = await f.engine.execute(plan.id, plan.digest);
  assert.equal(operation.status, 'completed');
  assert.equal(await fs.readFile(path.join(deployment.targetPath, 'script.txt'), 'utf8'), '远端新版本');
  assert.equal(await fs.readFile(path.join(operation.steps[0].snapshotPath, 'script.txt'), 'utf8'), '用户本地修改');
  const restore = await f.engine.plan({ kind: 'restore', operationId: operation.id });
  const restored = await f.engine.execute(restore.id, restore.digest);
  assert.equal(restored.status, 'completed');
  assert.equal(await fs.readFile(path.join(deployment.targetPath, 'script.txt'), 'utf8'), '用户本地修改');
});

test('恢复检查后续编辑，默认拒绝覆盖并可先保存当前内容', async t => {
  const f = await setup(t);
  await install(f);
  const deployment = f.engine.deployments()[0];
  await fs.writeFile(path.join(f.source, 'script.txt'), '新版');
  const updatePlan = await f.engine.plan({ kind: 'update', deploymentId: deployment.id, sourcePath: f.source });
  const updated = await f.engine.execute(updatePlan.id, updatePlan.digest);
  await fs.writeFile(path.join(deployment.targetPath, 'script.txt'), '更新后又编辑');
  const blocked = await f.engine.plan({ kind: 'restore', operationId: updated.id });
  assert.equal(blocked.blockers[0].code, 'LOCAL_MODIFIED');
  const force = await f.engine.plan({ kind: 'restore', operationId: updated.id, force: true });
  assert.deepEqual(force.blockers, []);
  const restored = await f.engine.execute(force.id, force.digest);
  assert.equal(restored.status, 'completed');
  assert.equal(await fs.readFile(path.join(restored.steps[0].snapshotPath, 'script.txt'), 'utf8'), '更新后又编辑');
  assert.equal(await fs.readFile(path.join(deployment.targetPath, 'script.txt'), 'utf8'), '原始脚本');
});

test('目标在更新预览之后变化返回 PLAN_STALE', async t => {
  const f = await setup(t);
  await install(f);
  const deployment = f.engine.deployments()[0];
  await fs.writeFile(path.join(f.source, 'script.txt'), '新版');
  const plan = await f.engine.plan({ kind: 'update', deploymentId: deployment.id, sourcePath: f.source });
  await fs.writeFile(path.join(deployment.targetPath, 'script.txt'), '新的本地编辑');
  await assert.rejects(f.engine.execute(plan.id, plan.digest), { code: 'PLAN_STALE' });
  assert.equal(await fs.readFile(path.join(deployment.targetPath, 'script.txt'), 'utf8'), '新的本地编辑');
});

test('三方差异识别新增、删除、附件变化和两端均有修改', async t => {
  const f = await setup(t);
  const baseline = await buildManifest(f.source);
  await fs.writeFile(path.join(f.source, 'script.txt'), '本地脚本改变');
  await fs.writeFile(path.join(f.source, 'local.pdf'), Buffer.from([0, 1, 2]));
  const local = await buildManifest(f.source);
  await fs.writeFile(path.join(f.source, 'script.txt'), '远端脚本改变');
  await fs.rm(path.join(f.source, 'local.pdf'));
  await fs.writeFile(path.join(f.source, 'remote.pdf'), Buffer.from([0, 1, 3]));
  const remote = await buildManifest(f.source);
  const diff = compareVersions(baseline, local, remote);
  assert.equal(diff.status, 'both-changed');
  assert.equal(diff.localChanged, true);
  assert.equal(diff.remoteChanged, true);
  assert.ok(diff.files.some(file => file.path === 'remote.pdf' && file.status === 'added'));
  assert.ok(diff.files.some(file => file.path === 'local.pdf' && file.status === 'deleted'));
  assert.equal(compareVersions(null, local, remote).status, 'unknown');
  assert.equal(compareVersions(baseline, remote, remote).status, 'aligned');
});

test('模拟目录已切换且数据库未提交，重启恢复登记而不重复复制', async t => {
  const f = await setup(t);
  const plan = await f.engine.plan({ kind: 'install', sourcePath: f.source, targets: [{ tool: 'codex', scope: 'user' }] });
  const step = { ...plan.steps[0], status: 'committed' };
  await fs.mkdir(path.dirname(step.targetPath), { recursive: true });
  await fs.cp(step.sourcePath, step.targetPath, { recursive: true });
  const committed = { ...plan, status: 'running', steps: [step] };
  f.store.put('operations', committed.id, committed);
  f.store.close();
  const reopened = new Store(f.dataDir);
  try {
    const restarted = new OperationEngine({ store: reopened, dataDir: f.dataDir, home: f.home, roots: () => [] });
    const recovered = await restarted.recover();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'completed');
    assert.equal(restarted.deployments().length, 1);
    assert.equal((await fingerprint(step.targetPath)).hash, step.afterHash);
    assert.deepEqual(await restarted.recover(), []);
  } finally { reopened.close(); }
});


test('祖先 Junction 将物理安装目标映射进来源时阻止计划', async t => {
  const f = await setup(t);
  const sourceBefore = await buildManifest(f.source);
  const aliasParent = path.join(f.home, '.agents');
  await fs.mkdir(aliasParent);
  await fs.symlink(f.source, path.join(aliasParent, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await f.engine.plan({ kind: 'install', sourcePath: f.source, targets: [{ tool: 'codex', scope: 'user' }] });
  assert.equal(plan.blockers[0].code, 'TARGET_CONFLICT');
  assert.equal(plan.steps.length, 0);
  await assert.rejects(f.engine.execute(plan.id, plan.digest), { code: 'PLAN_BLOCKED' });
  assert.equal((await buildManifest(f.source)).hash, sourceBefore.hash);
  assert.equal(await exists(path.join(f.source, 'example')), false);
});

test('中断后新增只读归属时自动恢复保留现场而不重新写入目标', async t => {
  const f = await setup(t);
  await install(f);
  const deployment = f.engine.deployments()[0];
  await fs.writeFile(path.join(f.source, 'script.txt'), '远端更新版本');
  const plan = await f.engine.plan({ kind: 'update', deploymentId: deployment.id, sourcePath: f.source });
  assert.deepEqual(plan.blockers, []);
  const step = { ...plan.steps[0], status: 'switching', retiredPath: path.join(path.dirname(deployment.targetPath), '.skill-manager-retired-readonly-test') };
  await fs.rename(step.targetPath, step.retiredPath);
  f.store.put('operations', plan.id, { ...plan, status: 'running', steps: [step] });
  f.roots.push({ path: path.dirname(step.targetPath), kind: 'plugin', readOnly: true });
  const restarted = new OperationEngine({ store: f.store, dataDir: f.dataDir, home: f.home, roots: () => f.roots });
  const reports = await restarted.recover();
  const recovered = reports.find(operation => operation.id === plan.id);
  assert.equal(recovered.status, 'recovery-required');
  assert.equal(recovered.steps[0].error.code, 'READ_ONLY_OWNER');
  assert.equal(await exists(step.targetPath), false);
  assert.equal(await exists(step.retiredPath), true);
  assert.equal((await buildManifest(step.retiredPath)).hash, step.beforeHash);
  assert.equal(f.engine.deployments()[0].baselineHash, deployment.baselineHash);
});

test('目标内出现 Git 资料时更新和移除均拒绝且完整保留资料', async t => {
  const f = await setup(t);
  await install(f);
  const deployment = f.engine.deployments()[0];
  const gitPath = path.join(deployment.targetPath, '.git');
  await fs.mkdir(gitPath);
  await fs.writeFile(path.join(gitPath, 'config'), '用户版本库配置');
  await fs.writeFile(path.join(gitPath, 'index'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(f.source, 'script.txt'), '远端更新版本');
  for (const force of [false, true]) {
    for (const kind of ['update', 'remove']) {
      const plan = await f.engine.plan({ kind, deploymentId: deployment.id, sourcePath: kind === 'update' ? f.source : undefined, force });
      assert.equal(plan.blockers[0].code, 'TARGET_REPOSITORY');
      await assert.rejects(f.engine.execute(plan.id, plan.digest), { code: 'PLAN_BLOCKED' });
    }
  }
  assert.equal(await fs.readFile(path.join(gitPath, 'config'), 'utf8'), '用户版本库配置');
  assert.deepEqual(await fs.readFile(path.join(gitPath, 'index')), Buffer.from([0, 1, 2, 3]));
  assert.equal(await fs.readFile(path.join(deployment.targetPath, 'script.txt'), 'utf8'), '原始脚本');
  assert.equal(f.engine.deployments().length, 1);
});
