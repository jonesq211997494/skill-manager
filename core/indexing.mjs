import path from 'node:path';

const canonical = value => typeof value === 'string' && value ? path.normalize(value) : null;
const aliasKey = alias => JSON.stringify([alias.rootId, canonical(alias.path)]);
const unique = values => [...new Set(values.filter(value => value != null && value !== ''))];
const activeRoots = roots => new Map((roots || []).filter(root => root.enabled !== false).map(root => [root.id, root]));
const identityOf = skill => typeof skill.identity === 'string' && skill.identity ? skill.identity : null;
const aliasReferences = aliases => aliases.map(({ rootId, path: location }) => ({ rootId, path: location }));

function filterAliases(aliases, roots) {
  const found = new Map();
  for (const alias of aliases || []) {
    const root = roots.get(alias.rootId);
    if (!root || !canonical(alias.path)) continue;
    const next = { ...alias, tools: [...(alias.tools || root.tools || [])], scope: alias.scope || root.scope || 'user' };
    const key = aliasKey(next);
    if (!found.has(key)) found.set(key, next);
    else {
      const previous = found.get(key);
      found.set(key, { ...previous, ...next, tools: unique([...previous.tools, ...next.tools]),
        kind: previous.kind === 'plugin' || next.kind === 'plugin' ? 'plugin' : next.kind || previous.kind,
        readOnly: previous.readOnly === true || next.readOnly === true });
    }
  }
  return [...found.values()];
}

function readonlyAlias(alias, roots) {
  const root = roots.get(alias.rootId);
  return alias.readOnly === true || alias.kind === 'plugin' || root?.readOnly === true || root?.kind === 'plugin';
}

function managementFor(previous, incoming, aliases, retained, roots) {
  if (aliases.some(alias => readonlyAlias(alias, roots))) return 'readonly';
  if (incoming?.management === 'readonly' && filterAliases(incoming.aliases, roots).length) return 'readonly';
  if (previous?.management === 'readonly' && retained.length) {
    const knownReadonly = (previous.aliases || []).filter(alias => readonlyAlias(alias, roots));
    if (!knownReadonly.length || retained.some(alias => knownReadonly.some(old => aliasKey(old) === aliasKey(alias)))) return 'readonly';
  }
  return previous?.management === 'managed' || incoming?.management === 'managed' ? 'managed' : 'external';
}

function decorate(skill, aliases, management) {
  const tools = unique(aliases.flatMap(alias => alias.tools || []));
  const scopes = unique(aliases.map(alias => alias.scope));
  return { ...skill, aliases, tools, scopes, scope: scopes.length === 1 ? scopes[0] : scopes.length ? 'multiple' : skill.scope || 'user',
    management, tracked: aliases.length > 0 };
}

function withScanIssue(skill, health, code, message) {
  const issues = (skill.issues || []).filter(issue => !['MISSING', 'INCOMPLETE_SCAN', 'SCAN_CANCELLED'].includes(issue.code));
  return { ...skill, health, issues: [...issues, { code, message }] };
}

/** 仅协调登记范围；取消登记不代表文件不存在，也不会删除元数据记录。 */
export function detachRoots(previous = [], roots = []) {
  const active = activeRoots(roots);
  return previous.map(skill => {
    const aliases = filterAliases(skill.aliases, active);
    const management = aliases.length ? managementFor(skill, null, aliases, aliases, active) : skill.management || 'external';
    const unverifiedAliases = aliasReferences(filterAliases(skill.unverifiedAliases, active));
    return decorate({ ...skill, unverifiedAliases }, aliases, management);
  });
}

/** 按物理实体合并同次扫描结果；不凭技能名称、内容哈希或路径大小写猜测同一实体。 */
function groupIncoming(skills = []) {
  const groups = [];
  const byEntity = new Map();
  for (const skill of skills) {
    const identity = identityOf(skill);
    const location = canonical(skill.physicalPath);
    const key = identity ? `identity:${identity}` : location ? `path:${location}` : Symbol();
    let group = byEntity.get(key);
    if (!group) {
      group = { identity, paths: new Set(), skills: [] };
      groups.push(group);
      byEntity.set(key, group);
    }
    group.paths.add(location);
    group.skills.push(skill);
  }
  return groups;
}

/** 将扫描证据与旧索引合并，不访问文件系统，也不修改技能文件。 */
export function reconcileScan(previous = [], result = {}, roots = []) {
  const active = activeRoots(roots);
  const reports = new Map((result.roots || []).map(report => [report.id, report]));
  const cancelled = result.cancelled === true;
  const rootComplete = rootId => !result.cancelled && reports.get(rootId)?.complete === true;
  const incomingGroups = groupIncoming(result.skills);
  const previousByPath = new Map();
  const previousByIdentity = new Map();
  for (const skill of previous) {
    for (const [index, key] of [[previousByPath, canonical(skill.physicalPath)], [previousByIdentity, identityOf(skill)]]) {
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(skill);
    }
  }
  const consumed = new Set();
  const reconciled = [];
  const seenPaths = new Set();
  const seenIdentities = new Set();

  for (const group of incomingGroups) {
    const byPath = [...group.paths].flatMap(location => previousByPath.get(location) || []).filter(skill => !consumed.has(skill.id));
    const old = byPath.find(skill => skill.tracked !== false) || byPath[0]
      || (previousByIdentity.get(group.identity) || []).find(skill => !consumed.has(skill.id));
    const representative = group.skills.find(skill => old && canonical(skill.physicalPath) === canonical(old.physicalPath)) || group.skills[0];
    const incoming = { ...representative, aliases: group.skills.flatMap(skill => skill.aliases || []) };
    if (group.skills.some(skill => skill.management === 'readonly')) incoming.management = 'readonly';
    else if (group.skills.some(skill => skill.management === 'managed')) incoming.management = 'managed';
    const retained = filterAliases(old?.aliases, active).filter(alias => !rootComplete(alias.rootId));
    const confirmedAliases = new Set(filterAliases(incoming.aliases, active).map(aliasKey));
    const unverifiedAliases = retained.filter(alias => !confirmedAliases.has(aliasKey(alias)));
    // 新发现的同一入口优先，未完成根中尚未遍历到的入口继续保留。
    const aliases = filterAliases([...retained, ...incoming.aliases], active);
    const identityChanged = !!old && !!identityOf(old) && !!group.identity && identityOf(old) !== group.identity;
    let skill = decorate({ ...old, ...incoming, id: old?.id || incoming.id, versionEvidenceStale: identityChanged, unverifiedAliases: aliasReferences(unverifiedAliases) }, aliases,
      managementFor(old, incoming, aliases, retained, active));
    if (cancelled && skill.tracked) skill = withScanIssue(skill, 'incomplete', 'INCOMPLETE_SCAN', '扫描未完成，已保留本次发现与上次索引。');
    else if (skill.tracked && unverifiedAliases.length) skill = withScanIssue(skill, 'incomplete', 'INCOMPLETE_SCAN', '部分历史入口本次尚未复核，保留其工具与范围归属，暂时不能确认版本。');
    reconciled.push(skill);
    if (old) consumed.add(old.id);
    for (const location of group.paths) if (location) seenPaths.add(location);
    if (group.identity) seenIdentities.add(group.identity);
  }

  for (const old of previous) {
    if (consumed.has(old.id)) continue;
    const aliases = filterAliases(old.aliases, active);
    const duplicate = seenPaths.has(canonical(old.physicalPath)) || !!identityOf(old) && seenIdentities.has(identityOf(old));
    if (duplicate) {
      // 合并重复实体后保留旧 ID 的隐藏记录，避免丢失独立保存的用户元数据。
      reconciled.push(decorate({ ...old, versionEvidenceStale: true, unverifiedAliases: [] }, [], old.management || 'external'));
      continue;
    }
    // 本次完全未找到时，旧入口仍是登记范围中的预期位置，可用于表达缺失状态。
    let skill = decorate({ ...old, versionEvidenceStale: false, unverifiedAliases: aliasReferences(aliases.filter(alias => !rootComplete(alias.rootId))) }, aliases,
      aliases.length ? managementFor(old, null, aliases, aliases, active) : old.management || 'external');
    if (skill.tracked) {
      const complete = !cancelled && aliases.every(alias => rootComplete(alias.rootId));
      skill = complete
        ? withScanIssue(skill, 'missing', 'MISSING', '相关登记目录已扫描完成，但未找到此技能。')
        : withScanIssue(skill, 'incomplete', 'INCOMPLETE_SCAN', '相关登记目录尚未完成扫描，保留上次索引。');
    }
    reconciled.push(skill);
  }
  return reconciled;
}