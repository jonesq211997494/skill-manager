export type ToolId = 'codex' | 'claude' | 'cursor';
export type VersionStatusCode = 'current' | 'available' | 'different' | 'local-changed' | 'both-changed' | 'unknown-source' | 'unchecked' | 'check-failed' | 'stale' | 'pinned' | 'mixed' | 'incomplete';
export type VersionStatus = {status: VersionStatusCode; label: string; description: string; checkedAt: string | null; checkedCount: number; totalCount: number; canCheck: boolean; states?: VersionState[]};
export type VersionState = {deploymentId?: string; tool?: ToolId; scope?: string; status: VersionStatusCode; label: string; description: string; checkedAt?: string | null; canCheck?: boolean; [key: string]: any};

export type FileEntry = { path: string; size?: number; bytes?: number; hash?: string; type?: string };
export type Deployment = { id: string; tool: ToolId; tools?: ToolId[]; scope: string; targetPath: string; baselineHash?: string; source?: any };
export type Skill = {
  id: string; name: string; alias?: string; description?: string; raw?: string; body?: string;
  metadata?: Record<string, any>; health?: string; issues?: any[]; physicalPath: string;
  aliases?: {path: string; tools?: ToolId[]; scope?: string; kind?: string; link?: any}[];
  tools?: ToolId[]; management?: string; configState?: any; tags?: string[];
  favorite?: boolean; pinned?: boolean; hash?: string; manifest?: {files?: FileEntry[]; [key: string]: any};
  deployments?: Deployment[]; source?: any; sourceBinding?: {id: string; source: any; trackingOnly: true; linkedAt: string}; versionStatus?: VersionStatus; versionStates?: VersionState[]; [key: string]: any;
};
export type Root = {id: string; path: string; kind?: string; tools?: ToolId[]; scope?: string; status?: string; error?: string; [key: string]: any};
export type GitHubRateLimit = {limit?: number; remaining?: number; reset?: string | number; retryAt?: string | number; cooldownUntil?: string | number};
export type GitHubStatus = {authenticated: boolean; user: {login: string; name?: string; id: number; avatarUrl?: string; htmlUrl?: string} | null; storageAvailable: boolean; browserAvailable: boolean; method?: string; expiresAt?: string; error?: unknown; rateLimits?: {resources?: {core?: GitHubRateLimit; search?: GitHubRateLimit}; cooldownUntil?: string | number}};
export type Bootstrap = {skills: Skill[]; roots: Root[]; settings: Record<string, any>; projects?: any[]; operations: any[]; adapters: any[]; updates?: any[]; sources: any[]; stats?: any; recovery?: any[]; github?: GitHubStatus};
export type Plan = {id: string; summary: any; steps: any[]; blockers: any[]; warnings: any[]; digest: string};
export const TOOL_NAMES: Record<string, string> = {codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor'};
export const STATUS_NAMES: Record<string, string> = {
  healthy: '正常', normal: '正常', ok: '正常', valid: '正常', missing: '文件缺失', broken: '链接断开',
  'broken-link': '链接断开', inaccessible: '读取受限', unreadable: '读取受限', invalid: '元数据异常',
  'metadata-error': '元数据异常', incomplete: '检查未完成', unknown: '未知', enabled: '启用',
  disabled: '停用', unsupported: '不支持', unconfigured: '未配置', external: '外部管理',
  managed: '已纳管', 'plugin-readonly': '插件只读', 'plugin-read-only': '插件只读', readonly: '只读',
  plugin: '插件只读', system: '系统只读', historical: '历史记录', current: '已是最新',
  aligned: '内容已一致', available: '可更新', different: '与来源不同', 'local-changed': '本地有改动', 'both-changed': '两端均有变化',
  'source-unavailable': '来源不可用', succeeded: '已完成', completed: '已完成', success: '已完成',
  failed: '失败', partial: '部分完成', running: '执行中', pending: '等待中', restored: '已恢复',
  'recovery-required': '需要恢复', install: '安装', import: '纳管', remove: '移除', update: '更新', restore: '恢复',
  active: '工具目录', candidate: '候选库', backup: '备份目录', history: '历史目录', cache: '缓存',
  alias: '路径别名', identical: '完整包相同', 'same-name': '同名差异', 'same-content': '完整包相同',
  added: '新增', modified: '修改', deleted: '删除', unchanged: '未变', changed: '变化',
};
export function label(value: any): string {
  if (value == null || value === '') return '未知';
  if (typeof value === 'object') return Object.entries(value).map(([key, val]) => `${TOOL_NAMES[key] || key}：${label(val)}`).join(' · ');
  return STATUS_NAMES[value] || String(value);
}
export function isReadonly(skill: Skill): boolean { return /readonly|read.only|plugin|system|只读|插件/.test(skill.management || ''); }
export function isHealthy(skill: Skill): boolean { return ['healthy','normal','ok','valid','正常'].includes(skill.health || '') && !(skill.issues?.length); }
export function displayName(skill: Skill): string { return skill.alias || skill.name; }
