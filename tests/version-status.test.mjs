import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVersionStates, getSkillVersionStatus, summarizeVersionStates } from '../shared/version-status.mjs';

const now = Date.parse('2026-10-04T04:00:00.000Z');
const hash = 'a'.repeat(64);
const changedHash = 'b'.repeat(64);
const source = { repositoryId: 7, fullName: 'example/skills', url: 'https://github.com/example/skills', subdir: 'demo', ref: 'main', commit: '1'.repeat(40) };
function fixture() {
  const directory = 'C:/fixture/.agents/skills/demo';
  const deployment = { id: 'deployment-1', tool: 'codex', scope: 'user', targetPath: directory, physicalTarget: directory,
    source: { ...source }, baselineHash: hash, baseline: { hash, complete: true } };
  const skill = { id: 'skill-1', name: 'demo', physicalPath: directory, tools: ['codex', 'cursor'], scopes: ['user'],
    aliases: [{ path: directory, tools: ['codex', 'cursor'], scope: 'user' }],
    management: 'managed', health: 'normal', hash, manifest: { hash, complete: true }, deployments: [deployment] };
  const update = { id: deployment.id, deploymentId: deployment.id, tool: 'codex', scope: 'user', targetPath: directory,
    checkedAt: new Date(now - 3600000).toISOString(), status: 'current', checkedSource: { ...source }, source: { ...source },
    baselineHash: hash, localHash: hash, remoteHash: hash };
  return { skill, deployment, update };
}
function stateFor(skill, updates) {
  const states = buildVersionStates(skill, updates, { now });
  assert.ok(Array.isArray(states));
  assert.ok(states.length > 0);
  return states.find(item => item.deploymentId === skill.deployments?.[0]?.id) || states[0];
}
function summary(skill, updates, options = {}) {
  return getSkillVersionStatus({ ...skill, versionStates: buildVersionStates(skill, updates, { now }) }, { now, ...options });
}

test('只有有效的最新检查证据才能显示已是最新', () => {
  const { skill, update } = fixture();
  const state = stateFor(skill, [update]);
  assert.equal(state.status, 'current');
  assert.equal(state.label, '已是最新');
  assert.equal(state.checkedAt, update.checkedAt);
  assert.equal(state.canCheck, true);
  assert.ok(state.description);
  assert.equal(summary(skill, [update]).status, 'current');
});

test('存在远端更新或本地修改时准确保留对应状态', () => {
  for (const status of ['available', 'local-changed', 'both-changed']) {
    const { skill, update } = fixture();
    update.status = status;
    if (status !== 'local-changed') update.remoteHash = changedHash;
    if (status !== 'available') { skill.hash = changedHash; skill.manifest.hash = changedHash; update.localHash = changedHash; }
    assert.equal(stateFor(skill, [update]).status, status);
    assert.equal(summary(skill, [update]).status, status);
  }
});

test('未知来源和外部只读包不把本地存在或相同名称当作最新证据', () => {
  for (const management of ['external', 'readonly']) {
    const { skill, update } = fixture();
    skill.management = management;
    skill.deployments = [];
    const result = summary(skill, [update]);
    assert.equal(result.status, 'unknown-source');
    assert.equal(result.canCheck, false);
    assert.notEqual(result.label, '已是最新');
  }
  const { skill, update } = fixture();
  skill.deployments[0].source = null;
  assert.equal(summary(skill, [update]).status, 'unknown-source');
});

test('有来源但尚未检查应显示未检查', () => {
  const { skill } = fixture();
  const state = stateFor(skill, []);
  assert.equal(state.status, 'unchecked');
  assert.equal(state.canCheck, true);
  assert.equal(summary(skill, []).status, 'unchecked');
});

test('失败检查保留失败信息与检查时间，不沿用已是最新', () => {
  const { skill, update } = fixture();
  update.status = 'source-unavailable';
  update.error = { code: 'RATE_LIMITED', message: 'GitHub 请求受限，请稍后重试。' };
  const state = stateFor(skill, [update]);
  assert.equal(state.status, 'check-failed');
  assert.equal(state.checkedAt, update.checkedAt);
  assert.equal(state.canCheck, true);
  assert.notEqual(summary(skill, [update]).status, 'current');
});

test('固定版本不等同于最新，即使曾检查为最新', () => {
  const { skill, update } = fixture();
  skill.pinned = true;
  assert.equal(stateFor(skill, [update]).status, 'pinned');
  assert.equal(summary(skill, [update]).status, 'pinned');
  assert.equal(summary(skill, [update]).canCheck, false);
});

test('超过二十四小时的检查证据明确过期并保留上次时间', () => {
  const { skill, update } = fixture();
  update.checkedAt = new Date(now - 24 * 3600000 - 1).toISOString();
  const state = stateFor(skill, [update]);
  assert.equal(state.status, 'stale');
  assert.equal(state.checkedAt, update.checkedAt);
  assert.equal(state.canCheck, true);
});

test('本地完整包哈希、基线或跟踪来源改变后旧证据必须失效', () => {
  for (const change of [
    ({ skill }) => { skill.hash = changedHash; skill.manifest.hash = changedHash; },
    ({ deployment }) => { deployment.baselineHash = changedHash; deployment.baseline.hash = changedHash; },
    ({ deployment }) => { deployment.source.ref = 'release'; },
    ({ deployment }) => { deployment.source.subdir = 'moved-demo'; },
    ({ deployment }) => { deployment.source.repositoryId = 99; },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(stateFor(f.skill, [f.update]).status, 'stale');
  }
});

test('不完整本地清单禁止显示最新', () => {
  const { skill, update } = fixture();
  skill.manifest.complete = false;
  const state = stateFor(skill, [update]);
  assert.equal(state.status, 'incomplete');
  assert.notEqual(summary(skill, [update]).status, 'current');
});

test('远端 source.commit 变化不等同于跟踪来源变化，旧版结果仍可核验', () => {
  const { skill, update } = fixture();
  update.status = 'available';
  update.source.commit = '2'.repeat(40);
  update.remoteHash = changedHash;
  assert.equal(stateFor(skill, [update]).status, 'available');
  delete update.checkedSource;
  assert.equal(stateFor(skill, [update]).status, 'available');
});

test('aligned 内容一致后切换基线仍可显示最新', () => {
  const { skill, deployment, update } = fixture();
  update.status = 'aligned';
  skill.hash = changedHash;
  skill.manifest.hash = changedHash;
  deployment.baselineHash = changedHash;
  deployment.baseline.hash = changedHash;
  update.localHash = changedHash;
  update.remoteHash = changedHash;
  assert.equal(stateFor(skill, [update]).status, 'current');
});

test('多个安装仅部分有当前证据时不能合并为全部最新', () => {
  const { skill, deployment, update } = fixture();
  skill.deployments.push({ ...deployment, id: 'deployment-2', tool: 'claude', targetPath: 'C:/fixture/.claude/skills/demo', physicalTarget: 'C:/fixture/.claude/skills/demo' });
  skill.tools.push('claude');
  const states = buildVersionStates(skill, [update], { now });
  assert.equal(states.length, 2);
  assert.notEqual(summarizeVersionStates(states, { now }).status, 'current');
  assert.notEqual(summary(skill, [update]).status, 'current');
});

test('工具和范围筛选选择对应部署，Cursor 能看到共享 .agents 的状态', () => {
  const { skill, deployment, update } = fixture();
  const other = { ...deployment, id: 'deployment-project', tool: 'claude', scope: 'C:/fixture/project',
    targetPath: 'C:/fixture/project/.claude/skills/demo', physicalTarget: 'C:/fixture/project/.claude/skills/demo' };
  skill.deployments.push(other);
  skill.tools.push('claude');
  skill.scopes.push(other.scope);
  skill.aliases.push({ path: other.targetPath, tools: ['claude'], scope: other.scope });
  const updates = [update, { ...update, id: other.id, deploymentId: other.id, tool: 'claude', scope: other.scope,
    targetPath: other.targetPath, status: 'available', remoteHash: changedHash }];
  assert.equal(summary(skill, updates, { tool: 'codex', scope: 'user' }).status, 'current');
  assert.equal(summary(skill, updates, { tool: 'cursor', scope: 'user' }).status, 'current');
  assert.equal(summary(skill, updates, { tool: 'claude', scope: other.scope }).status, 'available');
  const shared = buildVersionStates(skill, updates, { now }).find(item => item.deploymentId === deployment.id);
  assert.ok(shared.tools.includes('codex'));
  assert.ok(shared.tools.includes('cursor'));
  assert.ok(shared.scopes.includes('user'));
});
test('缺少本地完整包指纹或完整比较摘要时不能显示最新', () => {
  for (const change of [
    ({ skill }) => { delete skill.hash; delete skill.manifest; },
    ({ update }) => { delete update.localHash; },
    ({ update }) => { delete update.remoteHash; },
    ({ update }) => { update.remoteHash = changedHash; },
  ]) {
    const f = fixture();
    change(f);
    assert.notEqual(stateFor(f.skill, [f.update]).status, 'current');
  }
});
test('扫描未完成时不能凭旧的完整清单继续显示最新', () => {
  const { skill, update } = fixture();
  skill.health = 'incomplete';
  skill.issues = [{ code: 'INCOMPLETE_SCAN', message: '扫描未完成，保留上次索引' }];
  assert.notEqual(stateFor(skill, [update]).status, 'current');
});

test('页面持有的旧状态在二十四小时后聚合为待复查', () => {
  const { skill, update } = fixture();
  const states = buildVersionStates(skill, [update], { now });
  assert.equal(summarizeVersionStates(states, { now }).status, 'current');
  const later = now + 24 * 3600000;
  assert.equal(summarizeVersionStates(states, { now: later }).status, 'stale');
  assert.equal(getSkillVersionStatus({ ...skill, versionStates: states }, { now: later, tool: 'codex' }).status, 'stale');
});