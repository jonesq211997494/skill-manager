import { useEffect, useState } from 'react';
import { ArrowDownToLine, ChevronRight, FileCode2, FileText, FolderOpen, Layers3, LockKeyhole, Pin, Star, Trash2, X } from 'lucide-react';
import { Badge, bytes, Empty, IconButton, Loading, Markdown, Notice, PathLine, shortHash, ToolBadges } from './components';
import { displayName, isHealthy, isReadonly, label, TOOL_NAMES, type Skill } from './types';

export type Intent = {kind: 'install'|'import'|'remove'|'update'|'restore'; name?: string; skillIds?: string[]; sourcePath?: string; source?: any; deploymentId?: string; operationId?: string; force?: boolean; deployments?: any[]; targets?: any[]};
type Props = {skill?: Skill; loading: boolean; busy: boolean; onClose: () => void; onError: (error: unknown) => void; onOrganize: (id: string, patch: any) => void; onIntent: (intent: Intent) => void};

export default function Detail({skill, loading, busy, onClose, onError, onOrganize, onIntent}: Props) {
  const [tab, setTab] = useState('overview');
  const [alias, setAlias] = useState('');
  const [tags, setTags] = useState('');
  useEffect(() => {setTab('overview'); setAlias(skill?.alias || ''); setTags((skill?.tags || []).join('，'));}, [skill?.id]);
  useEffect(() => {setAlias(skill?.alias || ''); setTags((skill?.tags || []).join('，'));}, [skill?.alias, skill?.tags?.join(',')]);
  if (!skill) return <aside className="detail-panel empty-detail"><div className="detail-caption">技能详情</div><Empty icon={<FileText size={31}/>} title="从列表中选择一个技能" description="查看使用说明、完整文件清单与安装位置。"/><div className="detail-tip"><Layers3 size={16}/><span>一个技能，多处使用。<br/>所有路径关系都清楚呈现。</span></div></aside>;
  const readOnly = isReadonly(skill);
  const files = skill.manifest?.files || [];
  return <aside className="detail-panel is-open" aria-label="技能详情">
    <div className="detail-caption"><span>技能详情</span><IconButton title="关闭详情" onClick={onClose}><X size={17}/></IconButton></div>
    <div className="detail-title"><div className="skill-avatar large"><FileCode2 size={25}/></div><div className="detail-title-actions"><IconButton title={skill.favorite ? '取消收藏' : '收藏技能'} active={skill.favorite} onClick={() => onOrganize(skill.id, {favorite: !skill.favorite})}><Star size={18} fill={skill.favorite ? 'currentColor' : 'none'}/></IconButton><IconButton title={skill.pinned ? '取消固定版本' : '固定当前版本'} active={skill.pinned} onClick={() => onOrganize(skill.id, {pinned: !skill.pinned})}><Pin size={17}/></IconButton></div><h2>{displayName(skill)}</h2>{skill.alias && <p className="original-name">{skill.name}</p>}<p className="detail-description">{skill.description || '这个技能暂未提供描述。'}</p><div className="badge-line"><Badge tone={isHealthy(skill) ? 'success' : 'warning'}>{isHealthy(skill) ? '文件正常' : label(skill.health)}</Badge><Badge>{label(skill.management)}</Badge>{skill.pinned && <Badge tone="orange"><Pin size={10}/> 已固定</Badge>}</div></div>
    <div className="detail-tabs" role="tablist">{[['overview','概览'],['locations','位置'],['files','文件'],['raw','源码']].map(([key, name]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{name}{key === 'files' && <span>{files.length}</span>}</button>)}</div>
    <div className="detail-scroll">
      {loading ? <Loading text="正在读取完整技能包…"/> : <>
      {tab === 'overview' && <>
        {!!skill.issues?.length && <Notice tone="warning">{skill.issues.map((issue, i) => <div key={i}>{typeof issue === 'string' ? issue : issue.message || label(issue.code)}</div>)}</Notice>}
        <div className="detail-section"><div className="section-eyebrow">使用信息</div><dl className="metadata-list"><div><dt>关联工具</dt><dd><ToolBadges tools={skill.tools}/></dd></div><div><dt>配置状态</dt><dd>{label(skill.configState)}</dd></div><div><dt>版本标识</dt><dd><code>{String(skill.metadata?.version || shortHash(skill.hash))}</code></dd></div><div><dt>会话证据</dt><dd className="muted">无当前会话证据</dd></div></dl></div>
        <div className="detail-section"><div className="section-eyebrow">我的整理</div><label className="field-label">中文别名<input value={alias} placeholder="添加一个容易记住的名字" onChange={e => setAlias(e.target.value)}/></label><label className="field-label">标签<input value={tags} placeholder="用逗号分隔，例如：科研，写作" onChange={e => setTags(e.target.value)}/></label><button className="button small-button" disabled={busy || (alias === (skill.alias || '') && tags === (skill.tags || []).join('，'))} onClick={() => onOrganize(skill.id, {alias: alias.trim(), tags: tags.split(/[,，]/).map(v => v.trim()).filter(Boolean)})}>保存整理</button></div>
        <div className="detail-section"><div className="section-eyebrow">使用说明</div><Markdown text={skill.body || skill.raw || '暂无可预览的正文。'}/></div>
        {skill.metadata && Object.keys(skill.metadata).some(key => !['name','description'].includes(key)) && <details className="metadata-details"><summary>依赖与扩展字段 <ChevronRight size={14}/></summary><pre>{JSON.stringify(Object.fromEntries(Object.entries(skill.metadata).filter(([key]) => !['name','description'].includes(key))), null, 2)}</pre><p className="muted small">声明来自技能文件，运行依赖尚未验证。</p></details>}
      </>}
      {tab === 'locations' && <>
        <div className="detail-section"><div className="section-eyebrow">物理位置 · 1 份内容</div><PathLine path={skill.physicalPath} onError={onError}/></div>
        <div className="detail-section"><div className="section-eyebrow">发现入口 · {skill.aliases?.length || 0} 个</div>{skill.aliases?.map((item, index) => <div key={`${item.path}-${index}`} className="location-card"><div className="space-between"><Badge>{item.link ? '目录链接' : '目录'}</Badge><span className="muted small">{item.scope === 'user' ? '用户级' : item.scope || '未指定范围'}</span></div><PathLine path={item.path} onError={onError}/><ToolBadges tools={item.tools}/></div>)}</div>
        <div className="detail-section"><div className="section-eyebrow">受管理的安装 · {skill.deployments?.length || 0} 个</div>{skill.deployments?.length ? skill.deployments.map(item => <div className="location-card" key={item.id}><div className="space-between"><strong>{TOOL_NAMES[item.tool] || item.tool}</strong><Badge>{item.scope === 'user' ? '用户级' : '项目级'}</Badge></div><PathLine path={item.targetPath} onError={onError}/><div className="muted small">基线 {shortHash(item.baselineHash)}</div><button className="text-button danger-text" disabled={readOnly || busy} onClick={() => onIntent({kind: 'remove', name: displayName(skill), deploymentId: item.id, deployments: [item]})}><Trash2 size={13}/>预览移除这个安装</button></div>) : <p className="muted small">当前目录由外部工具管理。可以先纳管，建立可恢复的安装记录。</p>}</div>
        {skill.source && <div className="detail-section"><div className="section-eyebrow">来源记录</div><pre className="wrap-code">{JSON.stringify(skill.source, null, 2)}</pre></div>}
      </>}
      {tab === 'files' && <><div className="file-list-summary">完整包清单 <Badge>{files.length} 个文件</Badge></div>{files.length ? <div className="file-list">{files.map((file, index) => <div className="file-row" key={`${file.path}-${index}`}><FileText size={15}/><span title={file.path}>{file.path}</span><small>{bytes(file.size ?? file.bytes)}</small></div>)}</div> : <Notice>文件清单尚未完成，请重新扫描。读取受限或异常包不会被当作完整包参与去重。</Notice>}<div className="detail-section"><div className="section-eyebrow">完整包指纹</div><code className="hash-value">{skill.hash || '尚未计算'}</code></div></>}
      {tab === 'raw' && <pre className="source-code">{skill.raw || '暂无可读取的 SKILL.md 源码。'}</pre>}
      </>}
    </div>
    <div className="detail-footer">{readOnly ? <div className="readonly-note"><LockKeyhole size={14}/>此技能由插件或系统管理，只读查看</div> : <><button className="button primary" disabled={busy} onClick={() => onIntent({kind:'install',skillIds:[skill.id],name:displayName(skill)})}><ArrowDownToLine size={15}/>安装到工具</button><button className="button" disabled={busy} onClick={() => onIntent({kind:'import',skillIds:[skill.id],name:displayName(skill)})}><FolderOpen size={15}/>纳管</button></>}</div>
  </aside>;
}
