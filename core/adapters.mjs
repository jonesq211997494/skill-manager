import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

const shortHash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const timestamp = () => new Date().toISOString();

function locations(options = {}) {
  const home = path.resolve(options.home ?? os.homedir());
  // 环境覆盖独立于用户根目录；测试可显式传入空 env 隔离宿主配置。
  const env = options.env ?? process.env;
  return {
    home,
    codex: path.resolve(env.CODEX_HOME || path.join(home, '.codex')),
    claude: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
    projects: (options.projects ?? []).map(project => path.resolve(typeof project === 'string' ? project : project.path)),
  };
}

export async function discoverRoots(options = {}) {
  const { home, codex, claude, projects } = locations(options);
  const candidates = [];
  const add = (location, tools, scope = 'user', kind = 'active', extra = {}) => {
    const existing = candidates.find(root => root.path === location && root.scope === scope);
    if (existing) { existing.tools = [...new Set([...existing.tools, ...tools])]; return; }
    candidates.push({ id: `root-${shortHash(`${scope}\n${location}`)}`, path: location, kind, tools, scope, discovered: true, readOnly: kind === 'plugin', ...extra });
  };
  add(path.join(home, '.agents', 'skills'), ['codex', 'cursor'], 'user', 'active', { rule: '共享用户技能目录' });
  add(path.join(home, '.codex', 'skills'), ['codex', 'cursor'], 'user', 'active', { rule: '旧版兼容目录，实际发现待验证' });
  if (codex !== path.join(home, '.codex')) add(path.join(codex, 'skills'), ['codex'], 'user', 'active', { rule: 'CODEX_HOME 覆盖的兼容目录，实际发现待验证' });
  add(path.join(claude, 'skills'), claude === path.join(home, '.claude') ? ['claude', 'cursor'] : ['claude'], 'user', 'active', { rule: 'Claude 用户技能目录，Cursor 兼容发现待验证' });
  if (claude !== path.join(home, '.claude')) add(path.join(home, '.claude', 'skills'), ['cursor'], 'user', 'active', { rule: 'Cursor 兼容目录' });
  add(path.join(home, '.cursor', 'skills'), ['cursor'], 'user', 'active', { rule: 'Cursor 用户技能目录' });
  add(path.join(codex, 'plugins', 'cache'), ['codex'], 'user', 'plugin', { rule: 'Codex 插件缓存，仅供查看' });
  add(path.join(codex, 'skills', '.system'), ['codex'], 'user', 'plugin', { rule: 'Codex 安装目录内的内置系统技能，只读归属' });
  if (codex !== path.join(home, '.codex')) add(path.join(home, '.codex', 'skills', '.system'), ['codex', 'cursor'], 'user', 'plugin', { rule: 'Codex 兼容安装目录内的内置系统技能，只读归属' });
  add(path.join(claude, 'plugins', 'cache'), ['claude'], 'user', 'plugin', { rule: 'Claude 插件缓存，仅供查看' });
  for (const project of projects) {
    add(path.join(project, '.agents', 'skills'), ['codex', 'cursor'], project, 'active', { rule: '已登记项目共享目录；会话向上发现范围待验证' });
    add(path.join(project, '.codex', 'skills'), ['codex', 'cursor'], project, 'active', { rule: '项目兼容目录，实际发现待验证' });
    add(path.join(project, '.claude', 'skills'), ['claude', 'cursor'], project, 'active', { rule: '项目目录，父子目录发现待验证' });
    add(path.join(project, '.cursor', 'skills'), ['cursor'], project, 'active', { rule: 'Cursor 项目技能目录' });
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate.path);
      candidate.exists = stat.isDirectory();
      candidate.status = candidate.exists ? 'available' : 'not-directory';
    } catch (error) {
      candidate.exists = false;
      candidate.status = error.code === 'ENOENT' ? 'missing' : 'unreadable';
      candidate.issue = { code: error.code === 'ENOENT' ? 'PATH_MISSING' : 'PATH_UNREADABLE', message: error.code === 'ENOENT' ? '候选目录尚不存在' : '候选目录不可读取', path: candidate.path };
    }
  }
  return candidates;
}

export async function inspectAdapters(options = {}) {
  const roots = await discoverRoots(options);
  const { codex, claude } = locations(options);
  const definitions = [
    { id: 'codex', name: 'Codex', configPath: path.join(codex, 'config.toml'), configFormat: 'TOML', rule: '用户 .agents/skills；项目由工作目录至仓库根；.codex/skills 兼容扫描。', sharedWith: ['cursor'] },
    { id: 'claude', name: 'Claude Code', configPath: path.join(claude, 'settings.json'), configFormat: 'JSON', rule: '用户及项目 .claude/skills；附加目录与父子目录发现尚未验证。', sharedWith: ['cursor'] },
    { id: 'cursor', name: 'Cursor', configPath: null, configFormat: null, rule: '用户和项目 .agents/skills、.cursor/skills，兼容 .claude/skills、.codex/skills。', sharedWith: ['codex', 'claude'] },
  ];
  return definitions.map(adapter => ({
    ...adapter, tool: adapter.id, version: '未验证', verified: false, checkedAt: timestamp(),
    roots: roots.filter(root => root.tools.includes(adapter.id)),
    capabilities: {
      userInstall: true, projectInstall: true,
      configRead: adapter.id === 'codex' ? 'supported' : 'unverified',
      nativeDisable: false, configWrite: false, refresh: '需要由工具重新发现，生效时机待验证', sessionVisibility: false,
    },
    limitations: ['本地目录可发现不等于本机会话已加载', '尚未验证本机工具版本，原生配置写入不可用'],
  }));
}

async function normalizedConfigPath(value, base) {
  if (typeof value !== 'string') return null;
  const location = path.resolve(base, value);
  try { return await fs.realpath(location); }
  catch { return location; }
}

// 仅提取 skills.config 状态；其他配置及可能含凭据的原文不返回调用方。
export async function readConfigStates(skills, options = {}) {
  const { codex } = locations(options);
  const configPath = path.join(codex, 'config.toml');
  const result = { skills, issues: [], configPath, checkedAt: timestamp(), readable: false };
  let entries = [];
  try {
    const info = await fs.stat(configPath);
    if (info.size > 2 * 1024 * 1024) throw Object.assign(new Error('配置文件超过读取预算'), { code: 'CONFIG_BUDGET' });
    const config = parse(await fs.readFile(configPath, 'utf8'));
    entries = Array.isArray(config.skills?.config) ? config.skills.config : [];
    result.readable = true;
  } catch (error) {
    if (error.code === 'ENOENT') result.readable = true;
    else result.issues.push({ code: 'CONFIG_UNREADABLE', message: 'Codex 配置无法安全解析，启停状态保留为未知', path: configPath });
  }
  const states = [];
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || typeof entry.enabled !== 'boolean') continue;
    const normalized = await normalizedConfigPath(entry.path, codex);
    states.push({ path: normalized, state: entry.enabled ? 'enabled' : 'disabled' });
  }
  for (const skill of skills) {
    const paths = new Set([skill.physicalPath, ...(skill.aliases ?? []).map(alias => alias.path)]);
    const normalized = new Set();
    for (const location of paths) {
      if (!location) continue;
      const folder = await normalizedConfigPath(location, codex);
      normalized.add(folder);
      normalized.add(await normalizedConfigPath(path.join(location, 'SKILL.md'), codex));
    }
    const matched = states.filter(entry => normalized.has(entry.path));
    skill.configStates = {};
    for (const tool of skill.tools ?? []) skill.configStates[tool] = 'unknown';
    if (skill.tools?.includes('codex')) {
      const unique = [...new Set(matched.map(entry => entry.state))];
      skill.configStates.codex = !result.readable ? 'unknown' : unique.length > 1 ? 'unknown' : unique[0] ?? 'unconfigured';
      if (unique.length > 1) result.issues.push({ code: 'CONFIG_CONFLICT', message: '同一物理技能存在互相矛盾的配置入口，请人工核对', path: skill.physicalPath });
      skill.configState = skill.configStates.codex;
    } else skill.configState = 'unknown';
  }
  return result;
}
