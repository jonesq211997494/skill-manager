import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { reconcileScan, detachRoots } from '../core/indexing.mjs';

const directory = path.resolve('fixture', 'shared', 'demo');
const rootA = { id: 'a', path: path.resolve('fixture', 'codex'), tools: ['codex'], scope: 'user', kind: 'manual' };
const rootB = { id: 'b', path: path.resolve('fixture', 'plugin'), tools: ['cursor'], scope: 'project-one', kind: 'plugin', readOnly: true };
function alias(root, location = directory) {
  return { rootId: root.id, path: location, tools: [...root.tools], scope: root.scope, kind: root.kind };
}
function skill(extra = {}) {
  return { id: 'old-id', identity: 'file:1:101', name: 'demo', physicalPath: directory, health: 'normal',
    aliases: [alias(rootA)], tools: ['codex'], scopes: ['user'], scope: 'user', management: 'external',
    body: '原有正文', favorite: true, tags: ['保留用户信息'], ...extra };
}
function report(skills, states = [[rootA, true]], extra = {}) {
  return { skills, complete: states.every(([, complete]) => complete),
    roots: states.map(([root, complete]) => ({ ...root, complete, issues: [], skillIds: [] })), ...extra };
}

test('同物理路径重新扫描保留用户 ID，实体替换使旧版本证据失效', () => {
  const previous = skill();
  const incoming = skill({ id: 'new-scanner-id', identity: 'file:1:202', body: '新的正文' });
  const [result] = reconcileScan([previous], report([incoming]), [rootA]);
  assert.equal(result.id, previous.id);
  assert.equal(result.identity, incoming.identity);
  assert.equal(result.body, '新的正文');
  assert.equal(result.favorite, true);
  assert.deepEqual(result.tags, ['保留用户信息']);
  assert.equal(result.versionEvidenceStale, true);
  assert.equal(result.tracked, true);
  const [next] = reconcileScan([result], report([{ ...incoming, id: 'another-id' }]), [rootA]);
  assert.equal(next.id, previous.id);
  assert.equal(next.versionEvidenceStale, false);
});

test('完整扫描发现的别名替换该根旧入口，不继续显示已删除工具入口', () => {
  const oldAlias = alias(rootA, path.resolve('fixture', 'old-alias'));
  const nextAlias = alias(rootA, path.resolve('fixture', 'new-alias'));
  const previous = skill({ aliases: [oldAlias], tools: ['codex', 'obsolete'] });
  const incoming = skill({ aliases: [nextAlias] });
  const [result] = reconcileScan([previous], report([incoming]), [rootA]);
  assert.deepEqual(result.aliases.map(item => item.path), [nextAlias.path]);
  assert.deepEqual(result.tools, ['codex']);
});

test('部分根失败只保留该根的旧别名与只读归属', () => {
  const previous = skill({ aliases: [alias(rootA), alias(rootB, path.join(rootB.path, 'demo'))], management: 'readonly', tools: ['codex', 'cursor'] });
  const incoming = skill({ aliases: [alias(rootA)] });
  const [result] = reconcileScan([previous], report([incoming], [[rootA, true], [rootB, false]]), [rootA, rootB]);
  assert.deepEqual(result.aliases.map(item => item.rootId).sort(), ['a', 'b']);
  assert.deepEqual(result.tools.sort(), ['codex', 'cursor']);
  assert.deepEqual(result.scopes.sort(), ['project-one', 'user']);
  assert.equal(result.management, 'readonly');
  const [complete] = reconcileScan([result], report([incoming], [[rootA, true], [rootB, true]]), [rootA, rootB]);
  assert.deepEqual(complete.aliases.map(item => item.rootId), ['a']);
  assert.equal(complete.management, 'external');
});

test('无关根失败不能使已完整扫描根中的缺失技能变为未知', () => {
  const [result] = reconcileScan([skill()], report([], [[rootA, true], [rootB, false]]), [rootA, rootB]);
  assert.equal(result.health, 'missing');
  assert.equal(result.tracked, true);
  assert.deepEqual(result.aliases.map(item => item.rootId), ['a']);
  assert.equal(result.issues.at(-1).code, 'MISSING');
  assert.deepEqual(result.unverifiedAliases, []);
});

test('相关根尚未完成时保留技能为不完整，不能断定文件删除', () => {
  const previous = skill({ aliases: [alias(rootA), alias(rootB)] });
  const [result] = reconcileScan([previous], report([], [[rootA, true], [rootB, false]]), [rootA, rootB]);
  assert.equal(result.health, 'incomplete');
  assert.equal(result.tracked, true);
  assert.equal(result.issues.at(-1).code, 'INCOMPLETE_SCAN');
  assert.deepEqual(result.unverifiedAliases, [{ rootId: rootB.id, path: directory }]);
});

test('取消扫描时部分记录标记不完整，未遍历旧记录保留', () => {
  for (const result of [
    report([], [[rootA, true]], { cancelled: true }),
    report([], [[rootA, false]]),
    { skills: [], roots: [], complete: false },
    report([skill({ body: '部分读取结果' })], [[rootA, false]], { cancelled: true }),
  ]) {
    const [indexed] = reconcileScan([skill()], result, [rootA]);
    assert.equal(indexed.id, 'old-id');
    assert.equal(indexed.health, 'incomplete');
    assert.equal(indexed.tracked, true);
    assert.equal(indexed.aliases.length, 1);
  }
});

test('取消登记立即移除该根归属并隐藏无入口记录，不伪报文件缺失', () => {
  const previous = skill({ unverifiedAliases: [{ rootId: rootA.id, path: directory }] });
  const [detached] = detachRoots([previous], []);
  assert.equal(detached.tracked, false);
  assert.equal(detached.health, 'normal');
  assert.equal(detached.id, previous.id);
  assert.deepEqual(detached.aliases, []);
  assert.deepEqual(detached.unverifiedAliases, []);
  assert.deepEqual(detached.tools, []);
  assert.deepEqual(detached.tags, previous.tags);
  const [scanned] = reconcileScan([previous], { skills: [], roots: [], complete: true }, []);
  assert.equal(scanned.tracked, false);
  assert.equal(scanned.health, 'normal');
  const [disabled] = detachRoots([previous], [{ ...rootA, enabled: false }]);
  assert.equal(disabled.tracked, false);
});

test('重新登记同路径后恢复原 ID 与元数据，即使目录实体已经替换', () => {
  const [detached] = detachRoots([skill()], []);
  const incoming = skill({ id: 'different-id', identity: 'file:1:303' });
  delete incoming.favorite;
  delete incoming.tags;
  const [reappeared] = reconcileScan([detached], report([incoming]), [rootA]);
  assert.equal(reappeared.id, 'old-id');
  assert.equal(reappeared.favorite, true);
  assert.deepEqual(reappeared.tags, ['保留用户信息']);
  assert.equal(reappeared.tracked, true);
  assert.equal(reappeared.versionEvidenceStale, true);
});

test('同实体多个扫描条目只显示一次，严格区分同路径不同根的别名', () => {
  const first = skill({ id: 'scanner-1', aliases: [alias(rootA)] });
  const second = skill({ id: 'scanner-2', aliases: [alias(rootB)], management: 'readonly' });
  const result = reconcileScan([skill()], report([first, second], [[rootA, true], [rootB, true]]), [rootA, rootB]);
  assert.equal(result.filter(item => item.tracked).length, 1);
  assert.equal(result[0].id, 'old-id');
  assert.equal(result[0].aliases.length, 2);
  assert.deepEqual(result[0].aliases.map(item => item.rootId).sort(), ['a', 'b']);
  assert.equal(result[0].management, 'readonly');
});

test('相同名称与内容不能合并不同实体，路径大小写不会被擅自归一', () => {
  const upper = skill({ id: 'upper', identity: 'file:1:404', physicalPath: path.resolve('fixture', 'Demo'), aliases: [alias(rootA, path.resolve('fixture', 'Demo'))], hash: 'same-content' });
  const lower = skill({ id: 'lower', identity: 'file:1:405', physicalPath: path.resolve('fixture', 'demo'), aliases: [alias(rootA, path.resolve('fixture', 'demo'))], hash: 'same-content' });
  const result = reconcileScan([], report([upper, lower]), [rootA]);
  assert.equal(result.filter(item => item.tracked).length, 2);
  assert.deepEqual(result.map(item => item.id), ['upper', 'lower']);
});

test('失败根没有展开只读标识时仍保守保留旧只读归属', () => {
  const previous = skill({ management: 'readonly' });
  const [result] = reconcileScan([previous], report([], [[rootA, false]]), [rootA]);
  assert.equal(result.management, 'readonly');
  assert.equal(result.health, 'incomplete');
});

test('只读归属优先于管理状态，移除只读入口后保留其余登记范围', () => {
  const previous = skill({ management: 'managed', aliases: [alias(rootA)] });
  const incoming = skill({ management: 'readonly', aliases: [alias(rootA), alias(rootB)] });
  const [result] = reconcileScan([previous], report([incoming], [[rootA, true], [rootB, true]]), [rootA, rootB]);
  assert.equal(result.management, 'readonly');
  const [detached] = detachRoots([result], [rootA]);
  assert.equal(detached.tracked, true);
  assert.deepEqual(detached.aliases.map(item => item.rootId), ['a']);
  assert.equal(detached.management, 'external');
});

test('函数不修改输入对象，未匹配登记 ID 的别名不会绕过范围筛选', () => {
  const previous = [skill()];
  const incoming = skill({ aliases: [{ ...alias(rootA), rootId: 'not-registered' }] });
  const scan = report([incoming]);
  const snapshot = structuredClone({ previous, scan, roots: [rootA] });
  const result = reconcileScan(previous, scan, [rootA]);
  assert.equal(result[0].tracked, false);
  assert.deepEqual({ previous, scan, roots: [rootA] }, snapshot);
});

test('失败根保留的历史入口未重新见到时，不能凭另一已读入口确认最新', () => {
  const previous = skill({ aliases: [alias(rootA), alias(rootB, path.join(rootB.path, 'demo'))], management: 'readonly' });
  const incoming = skill({ aliases: [alias(rootA)], health: 'normal' });
  const [result] = reconcileScan([previous], report([incoming], [[rootA, true], [rootB, false]]), [rootA, rootB]);
  assert.equal(result.aliases.length, 2);
  assert.equal(result.management, 'readonly');
  assert.equal(result.health, 'incomplete');
  assert.match(result.issues.at(-1).message, /入口.*复核/);
  assert.deepEqual(result.unverifiedAliases, [{ rootId: rootB.id, path: path.join(rootB.path, 'demo') }]);
  const [detached] = detachRoots([result], [rootA]);
  assert.deepEqual(detached.unverifiedAliases, []);
});

test('失败根中的本技能入口已重新确认时，不受同根其它条目失败影响', () => {
  const previous = skill();
  const incoming = skill({ health: 'normal' });
  const [result] = reconcileScan([previous], report([incoming], [[rootA, false]]), [rootA]);
  assert.equal(result.aliases.length, 1);
  assert.equal(result.health, 'normal');
  assert.ok(!(result.issues || []).some(issue => issue.code === 'INCOMPLETE_SCAN'));
  assert.deepEqual(result.unverifiedAliases, []);
});
