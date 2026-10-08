import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Clock3, Copy, Database, Download, ExternalLink, FileDiff, FileText, FolderOpen, GitBranch, GitCompareArrows, Github, Globe2, History, Link2, ListFilter, Loader2, Package, Pin, Plus, RefreshCw, Search, Settings2, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { call, errorText, timestamp, type RunTask } from './api';
import StorageUsage from './StorageUsage';
import GitHubAccount, { CacheState } from './GitHubAccount';
import { Badge, bytes, dateTime, Empty, IconButton, Loading, Markdown, Modal, Notice, PathLine, shortHash, ToolBadges } from './components';
import { displayName, isReadonly, label, TOOL_NAMES, type Bootstrap, type Skill, type ToolId } from './types';
import { APP_VERSION } from './version';
import type { Intent } from './Detail';

const ROOT_STATUS_NAMES: Record<string,string> = {available:'可访问',partial:'部分完成',missing:'不存在','expected-missing':'尚未创建',unreadable:'访问受限'};

export type PageProps = {data: Bootstrap; busy: boolean; run: RunTask; reload: () => Promise<void>; onError: (error: unknown) => void; onIntent: (intent: Intent) => void; onSelect: (skill: Skill) => void; onOrganize: (id: string, patch: any) => void};

export function Discovery({data, busy, run, onIntent, reload}: PageProps) {
  const [mode, setMode] = useState('repositories');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any>();
  const [repository, setRepository] = useState<any>();
  const [reference, setReference] = useState('');
  const [sourceWarnings,setSourceWarnings] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState('all');
  const [preview, setPreview] = useState<any>();
  const [sourceSkills, setSourceSkills] = useState<any[] | null>(null);
  const [inspectedUrl,setInspectedUrl] = useState('');
  const authenticated = !!data.github?.authenticated;
  const refreshResource = mode === 'repositories' && !repository && !/^https?:\/\//i.test(query.trim()) ? 'search' : 'core';
  const resource = data.github?.rateLimits?.resources?.[refreshResource];
  const cooling = Math.max(timestamp(data.github?.rateLimits?.cooldownUntil), timestamp(resource?.cooldownUntil || resource?.retryAt || (resource?.remaining === 0 ? resource.reset : undefined))) > Date.now();
  useEffect(() => {setPreview(undefined);setRepository(undefined);setResults(undefined);setSourceSkills(null);setSourceWarnings([]);}, [data.github?.user?.id,authenticated]);
  const inspect = async (url: string, forceRefresh = false) => {
    if (!authenticated) return;
    const ref = reference.trim() || undefined;
    await run('正在读取仓库技能目录', async () => {
      const value = await call('sources.inspect', {url,ref,forceRefresh});
      setRepository(value);setInspectedUrl(url);setPreview(undefined);
      return value;
    }, {retryable:true,cancellable:true});
  };
  const search = async (page = 1, forceRefresh = false) => {
    if (!authenticated) return;
    const text = query.trim();
    const ref = reference.trim() || undefined;
    if (mode === 'repositories') {
      if (/^https?:\/\//i.test(text)) return inspect(text,forceRefresh);
      await run('正在搜索 GitHub 公开仓库', async () => {
        const value = await call('sources.search', {query:text || 'agent skills',page,forceRefresh});
        setResults(value);setRepository(undefined);
        return value;
      }, {retryable:true,cancellable:true});
    } else {
      const chosen = data.sources.filter(item => sourceId === 'all' || item.id === sourceId);
      await run('正在检索已配置来源', async () => {
        const all: any[] = [];
        const completed = await Promise.allSettled(chosen.map(source => call('sources.inspect', {url:source.url,ref,forceRefresh})));
        const warnings: string[] = [];
        completed.forEach((result,index) => {
          if(result.status === 'fulfilled') {
            const found = result.value;
            if(found.warning) warnings.push((chosen[index].name || chosen[index].url) + '：' + found.warning);
            for(const skill of found.skills || []) all.push({...skill,repository:found.repository,ref:found.ref,commit:found.commit,stale:found.stale,fromCache:found.fromCache,cachedAt:found.cachedAt,warning:found.warning});
          } else warnings.push((chosen[index].name || chosen[index].url) + '：' + errorText(result.reason));
        });
        setSourceWarnings(warnings);
        const failed = completed.find(result => result.status === 'rejected');
        if (completed.length && completed.every(result => result.status === 'rejected') && failed?.status === 'rejected') throw failed.reason;
        const value = all.filter(item => (item.name + ' ' + item.path + ' ' + (typeof item.repository === 'string' ? item.repository : JSON.stringify(item.repository))).toLowerCase().includes(text.toLowerCase()));
        setSourceSkills(value);return value;
      }, {retryable:true,cancellable:true});
    }
  };
  const showPreview = async (candidate: any) => {
    if (!authenticated) return;
    await run('正在下载并验证技能预览', async () => {
      const value = await call('sources.preview', {candidate});
      setPreview(value);return value;
    }, {retryable:true,cancellable:true});
  };
  const candidateCard = (item: any) => <div key={`${JSON.stringify(item.repository)}-${item.path}`} className="candidate-row"><div className="skill-avatar"><FileText size={21}/></div><div className="grow"><strong>{item.name}</strong><div className="muted small">{item.path || '仓库根目录'}</div><CacheState value={item}/></div><button className="button small-button" disabled={busy || !authenticated} onClick={() => showPreview(item)}>预览技能<ArrowRight size={13}/></button></div>;
  return <div className="page-content">
    <GitHubAccount status={data.github} reload={reload} compact/>
    <div className="discovery-banner"><div className="banner-copy"><span className="section-eyebrow">DISCOVER YOUR NEXT SKILL</span><h2>为你的工具，发现新能力。</h2><p>查找公开仓库，先看清技能内容，再选择安装位置。</p></div><div className="banner-art" aria-hidden="true"><div className="art-square back"><GitBranch size={29}/></div><div className="art-square front"><Package size={37}/></div><span className="art-spark">✦</span></div></div>
    <div className="segmented">{[['repositories','GitHub 仓库搜索'],['sources','已配置来源内搜索']].map(([key, name]) => <button key={key} className={mode === key ? 'selected' : ''} onClick={() => setMode(key)}>{key === 'repositories' ? <Github size={16}/> : <Database size={16}/>} {name}</button>)}</div>
    <form className="online-search" onSubmit={e => {e.preventDefault(); void search();}}><Search size={18}/><input aria-label="在线搜索" value={query} onChange={e => setQuery(e.target.value)} placeholder={mode === 'repositories' ? '搜索仓库关键词，或粘贴 GitHub 仓库 / 技能目录链接' : '搜索来源中的技能名称或子目录'}/>{mode === 'sources' && <select aria-label="选择来源" value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="all">全部来源</option>{data.sources.map(item => <option key={item.id} value={item.id}>{item.name || item.url}</option>)}</select>}<button className="button primary" disabled={busy || !authenticated || (mode === 'sources' && !data.sources.length)}>搜索</button></form>
    <div className="reference-field"><button type="button" className="text-button" disabled={busy || !authenticated || cooling} onClick={() => {void (repository && mode === 'repositories' ? inspect(inspectedUrl,true) : search(results?.page || 1,true));}}><RefreshCw size={13}/>从 GitHub 刷新</button><label>分支 / 标签 / 提交（可选）<input value={reference} onChange={e => setReference(e.target.value)} placeholder="默认分支；链接含歧义时可在此明确指定"/></label></div>
    {mode === 'sources' && sourceWarnings.map((message,index) => <Notice key={index} tone="warning">{message}</Notice>)}
    {mode === 'repositories' && !results && !repository && <div className="card source-intro"><div className="space-between"><h3>你的在线来源</h3><Badge>{data.sources.length} 个</Badge></div>{data.sources.length ? <div className="source-links">{data.sources.map(item => <button key={item.id} disabled={busy || !authenticated} onClick={() => inspect(item.url)}><Github size={19}/><span>{item.name || item.url.replace('https://github.com/','')}</span><ArrowUpRight size={16}/></button>)}</div> : <Empty icon={<Github size={26}/>} title="从一个公开仓库开始" description="搜索关键词，或直接粘贴 GitHub 链接。常用来源可以在设置中保存。"/>}</div>}
    {mode === 'repositories' && repository && <div className="card"><div className="card-heading"><button className="text-button" onClick={() => setRepository(undefined)}><ArrowLeft size={15}/>返回仓库</button><Badge>{repository.skills?.length || 0} 个技能</Badge></div><h3>{typeof repository.repository === 'string' ? repository.repository : repository.repository?.fullName || repository.repository?.name || '仓库内容'}</h3><p className="muted small">分支 {repository.ref} · 提交 {shortHash(repository.commit)}</p>{repository.warning && <Notice tone="warning">{repository.warning}</Notice>}<CacheState value={repository}/>{repository.skills?.length ? repository.skills.map((item: any) => candidateCard({...item, repository: repository.repository, ref: repository.ref, commit: repository.commit})) : <Empty icon={<FileText size={26}/>} title="这个位置没有发现技能" description="技能包需要包含 SKILL.md。可尝试仓库的其他分支或目录。"/>}</div>}
    {mode === 'repositories' && results && !repository && <>{results.warning && <Notice tone="warning">{results.warning}</Notice>}<div className="result-heading"><span>仓库搜索结果 <strong>{results.total ?? results.items?.length}</strong></span><CacheState value={results}/></div><div className="repository-grid">{results.items?.map((item: any) => <article className="repository-card" key={item.fullName || item.url}><div className="space-between"><Github size={23}/><span className="muted small"><Star size={12}/> {Number(item.stars || 0).toLocaleString()}</span></div><h3>{item.name || item.fullName?.split('/').pop()}</h3><div className="repository-author">{item.fullName || item.author}</div><p>{item.description || '这个仓库尚未提供描述。'}</p><button className="text-button" disabled={busy || !authenticated} onClick={() => inspect(item.url)}>查看仓库中的技能<ArrowRight size={14}/></button></article>)}</div>{!results.items?.length && <Empty icon={<Search size={27}/>} title="没有匹配的仓库" description="试试更短的关键词，或直接输入 GitHub 仓库链接。"/>}<div className="pagination"><button className="button small-button" disabled={busy || !authenticated || results.page <= 1} onClick={() => search(results.page - 1)}>上一页</button><span>第 {results.page || 1} 页</span><button className="button small-button" disabled={busy || !authenticated || (results.hasMore !== undefined ? !results.hasMore : !results.items?.length || results.page * (results.perPage || 30) >= results.total)} onClick={() => search((results.page || 1) + 1)}>下一页</button></div></>}
    {mode === 'sources' && <div className="card">{sourceSkills === null ? <Empty icon={<Database size={27}/>} title={data.sources.length ? '在你信任的来源中查找' : '还没有配置在线来源'} description={data.sources.length ? '选择一个来源或全部来源，输入关键词开始检索。' : '前往设置，添加公开 GitHub 仓库链接。'}/> : sourceSkills.length ? <><div className="result-heading">找到 {sourceSkills.length} 个技能</div>{sourceSkills.map(candidateCard)}</> : <Empty icon={<Search size={27}/>} title="来源中没有匹配的技能" description="可以清空关键词查看所有技能，或切换来源。"/>}</div>}
    {preview && <Modal title={preview.skill?.name || '在线技能预览'} subtitle="预览内容已经固定到本次仓库提交。" wide onClose={() => setPreview(undefined)} footer={<><span className="muted small">{preview.manifest?.files?.length || preview.skill?.manifest?.files?.length || 0} 个文件 · 运行依赖未验证</span><button className="button primary" disabled={busy || !authenticated} onClick={() => {onIntent({kind:'install',name:preview.skill?.name,sourcePath:preview.path,source:preview.source}); setPreview(undefined);}}><ArrowDownToLine size={15}/>选择安装位置</button></>}><CacheState value={preview}/><Notice>安装只会复制所选技能包。技能中的脚本不会在预览或安装时执行。</Notice><Markdown text={preview.skill?.body || preview.skill?.raw || preview.skill?.description || '暂无正文'}/><details className="metadata-details"><summary>查看完整文件清单<ChevronDown size={14}/></summary>{(preview.manifest?.files || preview.skill?.manifest?.files || []).map((file: any) => <div className="file-row" key={file.path}><FileText size={14}/><span>{file.path}</span><small>{bytes(file.size ?? file.bytes)}</small></div>)}</details></Modal>}
  </div>;
}

export function Duplicates({data, busy, run, onSelect}: PageProps) {
  const [groups, setGroups] = useState<any[] | null>(null);
  const [type, setType] = useState('all');
  const [compare, setCompare] = useState<Skill[] | null>(null);
  const analyze = async () => {await run('正在分析完整包与路径关系',async () => {const result = await call<any[]>('duplicates.analyze');setGroups(result);return result;}, {retryable:true,cancellable:true});};
  const selectedGroups = groups?.filter(group => type === 'all' || group.type === type);
  const openCompare = async (group: any) => {const result = await run('正在读取对比内容', () => Promise.all(group.skillIds.slice(0, 2).map((id: string) => call<Skill>('skills.detail', {id})))); if(result) setCompare(result as Skill[]);};
  return <div className="page-content"><div className="page-toolbar"><div><h2>看清关系，再做整理</h2><p className="muted">基于完整技能包分析，保留跨工具安装与目录链接。</p></div><button className="button primary" disabled={busy} onClick={analyze}><GitCompareArrows size={16}/>{groups ? '重新分析' : '开始分析'}</button></div><Notice>相同名称或相同内容并不代表可以删除。这里只呈现关系与差异，移除受管理的安装需逐项预览。</Notice>{groups === null ? <Empty icon={<Copy size={32}/>} title="让重复的原因变清楚" description="分析路径别名、相同内容、同名差异和必要安装副本，不会修改任何文件。"/> : <><div className="filter-pills"><button className={type === 'all' ? 'selected' : ''} onClick={() => setType('all')}>全部 <span>{groups.length}</span></button>{Array.from(new Set(groups.map(group => group.type))).map(key => <button key={key} className={type === key ? 'selected' : ''} onClick={() => setType(key)}>{label(key)}<span>{groups.filter(group => group.type === key).length}</span></button>)}</div>{selectedGroups?.length ? selectedGroups.map(group => <article className="card duplicate-card" key={group.id}><div className="space-between"><div className="inline"><div className="mini-symbol"><Copy size={18}/></div><h3>{group.title || label(group.type)}</h3><Badge>{group.skillIds.length} 个关联</Badge></div><button className="button small-button" disabled={busy || group.skillIds.length < 2} onClick={() => openCompare(group)}><FileDiff size={14}/>并排对比</button></div><p className="muted">{group.reason}</p>{group.skillIds.map((id: string) => {const skill = data.skills.find(item => item.id === id); return skill ? <button key={id} className="duplicate-skill" onClick={() => onSelect(skill)}><div className="grow"><strong>{displayName(skill)}</strong><code>{skill.physicalPath}</code></div><ToolBadges tools={skill.tools}/><ArrowRight size={15}/></button> : null;})}<div className="muted small duplicate-reason"><ShieldCheck size={13}/> {group.canDelete ? '整理前需检查所有安装关系' : '保留现有文件；不自动删除或合并来源身份'}</div></article>) : <Empty icon={<ShieldCheck size={30}/>} title="这个分类没有发现重复或冲突" description="当前扫描结果中的路径与内容关系已检查。"/>}</>}{compare && <Modal title="技能包并排对比" wide onClose={() => setCompare(null)}><div className="comparison-grid">{compare.map(skill => <section key={skill.id}><h3>{displayName(skill)}</h3><ToolBadges tools={skill.tools}/><div className="hash-pair"><span>完整包指纹</span><code>{shortHash(skill.hash)}</code></div><p className="muted small">{skill.manifest?.files?.length || 0} 个文件 · {label(skill.management)}</p><details><summary>文件与哈希</summary>{skill.manifest?.files?.map(file => <div className="compare-file" key={file.path}><span>{file.path}</span><code>{shortHash(file.hash)}</code></div>)}</details><Markdown text={skill.body || skill.raw || '没有可读正文'}/></section>)}</div></Modal>}</div>;
}

export function Updates({data, busy, run, onIntent, onOrganize, reload}: PageProps) {
  const [updates,setUpdates] = useState<any[]>(data.updates || []);
  useEffect(() => {setUpdates(data.updates || []);}, [data.updates]);
  const [checked,setChecked] = useState(false);
  const [fileComparison,setFileComparison] = useState<any>();
  const [expanded,setExpanded] = useState<string | null>(null);
  const authenticated = !!data.github?.authenticated;
  const compareFile = async (update: any,relativePath: string) => {
    await run(update.trackingOnly ? '正在读取本地与来源文件' : '正在读取三个版本的文件',async () => {
      const args = update.trackingOnly ? {bindingId:update.bindingId,relativePath} : {deploymentId:update.deploymentId,remotePath:update.remotePath,relativePath};
      const value = await call('files.compare',args);
      setFileComparison({...value,trackingOnly:!!update.trackingOnly});return value;
    }, {retryable:true});
  };
  const check = async () => {
    if(!authenticated) return;
    await run('正在比较本地与在线来源内容',async () => {
      const result = await call<any[]>('updates.check');
      setUpdates(result);setChecked(true);await reload();return result;
    }, {retryable:true,cancellable:true});
  };
  const changedLabel = (value: boolean | null | undefined) => value == null ? '未确认' : value ? '有变化' : '未检测到变化';
  return <div className="page-content"><GitHubAccount status={data.github} reload={reload} compact/>
    <div className="page-toolbar"><div><h2>更新之前，看清变化</h2><p className="muted">比较受管理的安装和已关联的来源，保留本地修订。</p></div><button className="button primary" disabled={busy || !authenticated} onClick={check}><RefreshCw size={15}/>检查更新</button></div>
    <div className="update-legend"><span><span className="status-dot green"/>基线：上次安装的内容</span><span><span className="status-dot orange"/>本地：当前文件内容</span><span><span className="status-dot purple"/>来源：本次检查的内容</span></div>
    {!updates.length ? <Empty icon={<Download size={31}/>} title={checked ? '没有需要比较的在线来源' : '检查技能的在线来源'} description={checked ? '从在线来源安装技能，或在技能详情中关联来源后，可查看比较结果。' : '外部技能只跟踪内容差异；受管理的安装可以预览更新。'}/> : updates.map((update,index) => {
      const key = update.id || update.bindingId || update.deploymentId || String(index);
      const skill = data.skills.find(item => item.id === update.skillId || item.deployments?.some(dep => dep.id === update.deploymentId));
      const canUpdate = !update.trackingOnly && !!update.remotePath && !skill?.pinned && !(skill && isReadonly(skill)) && ['available','both-changed','aligned'].includes(update.status);
      const versions = update.trackingOnly ? [['localHash','本地'],['remoteHash','来源']] : [['baselineHash','基线'],['localHash','本地'],['remoteHash','远端']];
      return <article className="card update-card" key={key}>
        <div className="space-between"><div className="inline"><div className="skill-avatar"><GitBranch size={21}/></div><div><h3>{update.name || skill?.name || '技能安装'}</h3><div className="muted small">{TOOL_NAMES[update.tool] || update.tool || ''} {update.scope === 'user' ? '用户级' : update.scope || ''}</div></div></div><Badge tone={update.status === 'current' || update.status === 'aligned' ? 'success' : update.status === 'different' ? '' : 'warning'}>{label(update.status)}</Badge></div>
        {update.trackingOnly && <p className="tracking-only-note"><Link2 size={13}/>仅跟踪 · 原文件由外部管理</p>}
        <div className="update-flags"><span>本地内容 <strong>{changedLabel(update.localChanged)}</strong></span><span>来源内容 <strong>{changedLabel(update.remoteChanged)}</strong></span></div>
        {update.status === 'different' && <Notice>本地内容与来源不同；没有可靠安装基线，不能据此判断哪一份较新。</Notice>}
        {update.error && <Notice tone="error">{typeof update.error === 'string' ? update.error : update.error.message}</Notice>}
        {update.localChanged && !update.trackingOnly && <Notice tone="warning">本地修订需要保留。替换时会保存当前内容的恢复快照，请先查看差异。</Notice>}
        <div className="update-actions"><button className="text-button" onClick={() => setExpanded(expanded === key ? null : key)}><FileDiff size={14}/>{expanded === key ? '收起差异' : '查看文件差异（' + (update.files?.length || 0) + '）'}</button><div className="inline">
          {skill && <button className={'button small-button' + (skill.pinned ? ' selected' : '')} disabled={busy} onClick={() => onOrganize(skill.id,{pinned:!skill.pinned})}><Pin size={13}/>{skill.pinned ? '已固定 · 点击取消' : '固定当前版本'}</button>}
          {!update.trackingOnly && <button className="button primary small-button" disabled={busy || !canUpdate} onClick={() => onIntent({kind:'update',name:update.name,deploymentId:update.deploymentId,sourcePath:update.remotePath,source:update.source,force:update.localChanged})}>预览更新</button>}
        </div></div>
        {expanded === key && <div className="version-diff"><div className={'hash-columns' + (update.trackingOnly ? ' two-columns' : '')}>{versions.map(([field,name]) => <div key={field}><span>{name}</span><code>{shortHash(update[field])}</code></div>)}</div>{update.files?.length ? update.files.map((file: any,i: number) => <button className="file-row diff-file-button" disabled={busy} key={file.path + '-' + i} onClick={() => compareFile(update,file.path)}><FileText size={14}/><span>{file.path}</span><Badge>{label(file.status)}</Badge><ArrowRight size={13}/></button>) : <p className="muted small">没有文件差异记录。</p>}</div>}
      </article>;
    })}
    {fileComparison && <Modal title={(fileComparison.trackingOnly ? '本地与来源比较 · ' : '三方文件比较 · ') + fileComparison.path} wide onClose={() => setFileComparison(undefined)}><div className={'three-way-comparison' + (fileComparison.trackingOnly ? ' two-columns' : '')}>{(fileComparison.trackingOnly ? [['local','当前本地'],['remote','在线来源']] : [['baseline','安装基线'],['local','当前本地'],['remote','远端版本']]).map(([key,name]) => {
      const file = fileComparison[key] || {};
      return <section key={key}><div className="space-between"><h3>{name}</h3><Badge>{file.missing ? '文件不存在' : file.binary ? '二进制文件' : '文本文件'}</Badge></div><code className="diff-hash">{shortHash(file.hash)}</code>{file.missing ? <p className="muted small">此版本不包含该文件</p> : file.binary ? <p className="muted small">二进制内容不作文本展示，请根据哈希与文件清单判断差异。</p> : <pre>{file.text ?? '文本预览不可用'}</pre>}</section>;
    })}</div></Modal>}
  </div>;
}

export function HistoryPage({data, busy, onIntent}: PageProps) {
  return <div className="page-content"><div className="page-toolbar"><div><h2>每一步，都有迹可循</h2><p className="muted">查看变更结果与快照，按需恢复到操作之前。</p></div><Badge>{data.operations.length} 条记录</Badge></div>{data.operations.length ? <div className="history-list">{data.operations.map(operation => <article className="card history-card" key={operation.id}><div className="history-marker"><History size={17}/></div><div className="grow"><div className="space-between"><div className="inline"><h3>{label(operation.kind)}{typeof operation.summary === 'string' ? ` · ${operation.summary}` : ''}</h3><Badge tone={['failed','partial','recovery-required'].includes(operation.status) ? 'warning' : 'success'}>{label(operation.status)}</Badge></div><span className="muted small">{dateTime(operation.createdAt || operation.startedAt || operation.timestamp)}</span></div><p className="muted small">操作 {operation.id}</p>{operation.error && <Notice tone="error">{typeof operation.error === 'string' ? operation.error : operation.error.message}</Notice>}<details className="operation-steps"><summary>查看变更与快照 <ChevronDown size={14}/></summary>{(operation.steps || operation.plan?.steps || []).map((step: any, index: number) => <div className="history-step" key={index}><Badge>{label(step.action || step.kind)}</Badge><code>{step.targetPath || step.path}</code><span>{label(step.status || operation.status)}</span>{(step.snapshotPath || step.backupPath) && <div className="muted small">快照：{step.snapshotPath || step.backupPath}</div>}{step.error && <Notice tone="error">{typeof step.error === 'string' ? step.error : step.error.message}</Notice>}</div>)}</details><div className="history-actions"><span className="muted small"><ShieldCheck size={13}/>恢复前会重新检查当前文件</span><button className="button small-button" disabled={busy || operation.kind === 'restore' || operation.status === 'restored' || ['running','pending'].includes(operation.status)} onClick={() => onIntent({kind:'restore',operationId:operation.id,name:`${label(operation.kind)}操作`})}><History size={14}/>预览恢复</button></div></div></article>)}</div> : <Empty icon={<Clock3 size={31}/>} title="还没有文件变更记录" description="安装、复制到集中库、更新或移除技能后，这里会保存具体结果与恢复入口。"/>}</div>;
}

export function SettingsPage({data, busy, run, reload, onError}: PageProps) {
  const [settings, setSettings] = useState<Record<string, any>>(data.settings);
  const [sourceUrl, setSourceUrl] = useState('');
  const [migrationPath, setMigrationPath] = useState('');
  const [report, setReport] = useState<any>();
  const [projectToRemove,setProjectToRemove] = useState<any>();
  const [projectRemoveError,setProjectRemoveError] = useState('');
  const [rootKind, setRootKind] = useState('candidate');
  useEffect(() => {setSettings(data.settings);}, [data.settings]);
  const patch = (key: string, value: any) => setSettings(previous => ({...previous,[key]:value}));
  const addRoot = async () => {await run('正在添加扫描目录', async () => {const path = await call('dialog.directory'); if(path) {await call('roots.add',{path,kind:rootKind,tools:[],scope:'user'}); await reload();}});};
  const addProject = async () => {await run('正在登记项目',async () => {const path = await call('dialog.directory'); if(path) {await call('projects.add',{path}); await reload();}});};
  return <div className="page-content settings-page"><div className="page-toolbar"><div><h2>按你的工作方式设置</h2><p className="muted">目录、来源与偏好，集中管理。</p></div><button className="button primary" disabled={busy} onClick={() => run('正在保存设置', async () => {await call('settings.save',settings); await reload();})}><Check size={16}/>保存设置</button></div>
    <GitHubAccount status={data.github} reload={reload}/>
    <section className="card settings-card"><div className="settings-heading"><FolderOpen size={19}/><div><h3>扫描目录</h3><p>原位置只读索引，扫描不会移动现有技能。</p></div></div>{data.roots.map(root => <div className="setting-path" key={root.id}><div className="grow"><div className="inline"><Badge>{label(root.kind)}</Badge><ToolBadges tools={root.tools}/>{root.status && <span className="muted small">{ROOT_STATUS_NAMES[root.status] || label(root.status)}</span>}</div><PathLine path={root.path} onError={onError}/>{root.error && <span className="danger-text small">{root.error}</span>}</div><IconButton title="移除扫描目录登记" disabled={busy} onClick={() => run('正在移除目录登记',async () => {await call('roots.remove',{id:root.id}); await reload();})}><Trash2 size={15}/></IconButton></div>)}<div className="inline top-gap"><select aria-label="目录用途" value={rootKind} onChange={e => setRootKind(e.target.value)}><option value="candidate">候选技能库</option><option value="active">工具目录</option><option value="backup">备份目录</option><option value="history">历史目录</option></select><button className="button" disabled={busy} onClick={addRoot}><Plus size={14}/>添加目录</button></div></section>
    <section className="card settings-card"><div className="settings-heading"><LayersSymbol/><div><h3>项目范围</h3><p>登记项目后，可在安装时单独选择项目级位置。</p></div><button className="button small-button" disabled={busy} onClick={addProject}><Plus size={14}/>添加项目</button></div>{(data.projects || settings.projects || []).length ? (data.projects || settings.projects || []).map((project: any) => <div className="setting-path" key={project.id || project.path}><div className="grow"><strong>{project.name || project.path?.split(/[\\/]/).pop()}</strong><PathLine path={project.path || project} onError={onError}/></div><IconButton title="移除项目登记" disabled={busy || !project.id} onClick={() => {setProjectRemoveError('');setProjectToRemove(project);}}><Trash2 size={15}/></IconButton></div>) : <p className="muted small">尚未登记项目。用户级安装始终可选。</p>}</section>
    <section className="card settings-card"><div className="settings-heading"><Github size={19}/><div><h3>在线来源</h3><p>保存常用的公开 GitHub 仓库或技能目录。</p></div></div>{data.sources.map(source => <div className="source-setting" key={source.id}><Link2 size={15}/><div className="grow"><strong>{source.name || source.url.replace('https://github.com/','')}</strong><span>{source.url}</span></div><IconButton title="移除在线来源" disabled={busy} onClick={() => run('正在移除来源',async () => {await call('sources.remove',{id:source.id}); await reload();})}><Trash2 size={15}/></IconButton></div>)}<form className="inline top-gap" onSubmit={e => {e.preventDefault(); void run('正在保存来源',async () => {await call('sources.add',{url:sourceUrl.trim()}); setSourceUrl(''); await reload();});}}><input aria-label="新来源链接" className="grow" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://github.com/owner/repository"/><button className="button" disabled={busy || !sourceUrl.trim()}><Plus size={14}/>添加</button></form></section>
    <div className="settings-grid"><section className="card settings-card"><div className="settings-heading"><Settings2 size={19}/><div><h3>外观与网络</h3><p>让长时间管理更舒适。</p></div></div><label className="field-label">主题<select value={settings.theme || 'light'} onChange={e => patch('theme',e.target.value)}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><label className="field-label">界面字号<select value={settings.fontSize || 14} onChange={e => patch('fontSize',Number(e.target.value))}>{[12,13,14,15,16,18].map(size => <option value={size} key={size}>{size} px</option>)}</select></label><label className="field-label">网络代理<input value={settings.proxy || ''} onChange={e => patch('proxy',e.target.value)} placeholder="留空使用默认网络，例如 http://127.0.0.1:7890"/></label></section><section className="card settings-card"><div className="settings-heading"><Database size={19}/><div><h3>集中库与备份</h3><p>快照与技能发现目录分开存储。</p></div></div><label className="field-label">集中库位置<div className="inline"><input value={settings.libraryPath || ''} onChange={e => patch('libraryPath',e.target.value)} className="grow"/><IconButton title="选择集中库位置" onClick={() => run('选择集中库位置',async () => {const path = await call('dialog.directory'); if(path) patch('libraryPath',path);})}><FolderOpen size={16}/></IconButton></div></label><div className="two-fields"><label className="field-label">期望保留天数<input type="number" min="1" value={settings.backupDays ?? 30} onChange={e => patch('backupDays',Number(e.target.value))}/></label><label className="field-label">每项期望至少保留<input type="number" min="1" value={settings.backupMinimum ?? 3} onChange={e => patch('backupMinimum',Number(e.target.value))}/></label></div><label className="field-label">容量提醒阈值（GB）<input type="number" min="1" value={settings.backupLimitGB ?? 5} onChange={e => patch('backupLimitGB',Number(e.target.value))}/></label><p className="muted small">以上为保留偏好，尚不自动清理。下方存储用量按已保存的阈值提醒，不会自动删除恢复快照。</p></section></div>
    <StorageUsage busy={busy} run={run} limitGB={data.settings.backupLimitGB ?? 5}/>
    <section className="card settings-card"><div className="settings-heading"><History size={19}/><div><h3>旧数据与整理记录核对</h3><p>生成只读迁移报告，与当前文件事实核对。</p></div></div><div className="inline"><input className="grow" aria-label="旧数据库或整理记录路径" value={migrationPath} onChange={e => setMigrationPath(e.target.value)} placeholder="旧数据库文件、JSON 清单或包含整理记录的目录"/><button className="button" disabled={busy || !migrationPath.trim()} onClick={() => run('正在核对历史记录',async () => {const value = await call('migration.preview',{path:migrationPath.trim()}); setReport(value);})}>生成核对报告</button></div></section>
    <div className="about-line"><div className="brand-mini">S</div><div><strong>Skillspace 技能管理器</strong><span>本地优先 · 公开来源 · 可恢复操作</span></div><Badge>v{APP_VERSION} · 开发预览</Badge></div>
    {projectToRemove && <Modal title="移除项目登记" subtitle={projectToRemove.name || projectToRemove.path} onClose={() => {if(!busy) setProjectToRemove(undefined);}} footer={<><button className="button" disabled={busy} onClick={() => setProjectToRemove(undefined)}>返回</button><button className="button primary" disabled={busy} onClick={() => run('正在移除项目登记',async () => {try {await call('projects.remove',{id:projectToRemove.id});await reload();setProjectToRemove(undefined);} catch(value) {setProjectRemoveError(errorText(value));throw value;}})}>确认移除登记</button></>}><Notice>只移除这个项目及其扫描目录的登记，不删除或修改项目文件。</Notice><PathLine path={projectToRemove.path} onError={onError}/>{projectRemoveError && <Notice tone="error">{projectRemoveError}</Notice>}</Modal>}
    {report && <Modal title="历史数据核对报告" wide onClose={() => setReport(undefined)} footer={<><span className="muted small">仅登记核对后的标签、分类和历史证据</span><button className="button primary" disabled={busy || !report.id} onClick={() => run('正在登记迁移核对结果',async () => {await call('migration.import',{id:report.id});await reload();setReport(undefined);})}>确认登记</button></>}><Notice>此报告只读取旧记录。以当前文件与配置为准，原数据保持原样。</Notice><pre className="report-code">{JSON.stringify(report,null,2)}</pre></Modal>}
  </div>;
}
function LayersSymbol() {return <Package size={19}/>;}
