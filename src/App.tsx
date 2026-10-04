import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Archive, ArrowDownToLine, ArrowRight, Bell, BookOpen, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Command, Copy, Database, Download, FileText, FolderOpen, GitCompareArrows, Globe2, Grid2X2, History, Layers3, ListFilter, Loader2, Monitor, Package, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Star, Terminal, X } from 'lucide-react';
import { call, errorText, errorRetryAt, requiresGitHubLogin, subscribeProgress, type Progress } from './api';
import { Badge, bytes, Empty, IconButton, Loading, Modal, Notice, PathLine, ToolBadges } from './components';
import Detail, { type Intent } from './Detail';
import { getSkillVersionStatus } from '../shared/version-status.mjs';
import { Discovery, Duplicates, HistoryPage, SettingsPage, Updates, type PageProps } from './Pages';
import { displayName, isHealthy, isReadonly, label, TOOL_NAMES, type Bootstrap, type GitHubStatus, type Plan, type Skill, type ToolId } from './types';

type Page = 'skills' | 'tools' | 'discover' | 'duplicates' | 'updates' | 'history' | 'settings';
const NAV = [
  {id:'skills' as Page, title:'我的技能', icon:Grid2X2},
  {id:'tools' as Page, title:'按工具查看', icon:Terminal},
  {id:'discover' as Page, title:'在线发现', icon:Globe2},
  {id:'duplicates' as Page, title:'重复与冲突', icon:GitCompareArrows},
  {id:'updates' as Page, title:'更新', icon:Download},
  {id:'history' as Page, title:'操作历史', icon:History},
];
const INITIAL: Bootstrap = {skills:[], roots:[], settings:{theme:'light',fontSize:14}, operations:[], adapters:[], updates:[], sources:[], recovery:[]};

export default function App() {
  const [data, setData] = useState<Bootstrap>(INITIAL);
  const [page, setPage] = useState<Page>('skills');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [loginNeeded, setLoginNeeded] = useState(false);
  const [retryUntil, setRetryUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [versionNow, setVersionNow] = useState(Date.now());
  const [retryTask, setRetryTask] = useState<{message: string; task: () => Promise<unknown>} | null>(null);
  const [toast, setToast] = useState('');
  const [checkNotice, setCheckNotice] = useState('');
  const [selected, setSelected] = useState<Skill>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [tool, setTool] = useState('all');
  const [scope, setScope] = useState('all');
  const [tag, setTag] = useState('all');
  const [state, setState] = useState('all');
  const [favorites, setFavorites] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [listPage, setListPage] = useState(1);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [rootDialog, setRootDialog] = useState(false);
  const [rootPath, setRootPath] = useState('');
  const [rootKind, setRootKind] = useState('candidate');
  const [lastRefresh, setLastRefresh] = useState<Date>();
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRequest = useRef(0);
  const taskActive = useRef(false);
  const onError = useCallback((value: unknown) => {setError(errorText(value));setLoginNeeded(requiresGitHubLogin(value));setRetryUntil(['RATE_LIMITED','AUTH_RATE_LIMITED'].includes((value as any)?.code) ? errorRetryAt(value) : 0);setRetryTask(null);}, []);

  const load = useCallback(async () => {
    const next = await call<Bootstrap>('bootstrap');
    setData({...INITIAL,...next, skills:next.skills || [], roots:next.roots || [], operations:next.operations || [], adapters:next.adapters || [], sources:next.sources || []});
    setSelected(previous => {if (!previous) return previous; const fresh = next.skills?.find(item => item.id === previous.id); return fresh ? {...previous,...fresh} : undefined;});
    setSelection(previous => new Set([...previous].filter(id => next.skills?.some(item => item.id === id))));
    setLastRefresh(new Date());
  }, []);
  const refreshGitHub = useCallback(async () => {
    const github = await call<GitHubStatus>('github.status');
    setData(previous => ({...previous,github}));
  }, []);
  const run = useCallback(async <T,>(message: string, task: () => Promise<T>, options?: {retryable?: boolean}): Promise<T | undefined> => {
    if (taskActive.current) return undefined;
    taskActive.current = true; setBusy(true); setBusyLabel(message); setError(''); setRetryTask(null);setLoginNeeded(false);setRetryUntil(0); setProgress(null);
    try { return await task(); }
    catch(value) {onError(value);if(options?.retryable && !requiresGitHubLogin(value)) setRetryTask({message,task});return undefined;}
    finally {taskActive.current = false; setBusy(false); setProgress(null);void refreshGitHub().catch(() => {});}
  }, [onError,refreshGitHub]);
  useEffect(() => {let alive = true;const poll = () => {void call<GitHubStatus>('github.status').then(github => {if(alive) setData(previous => ({...previous,github}));}).catch(() => {});};poll();const timer = setInterval(poll,5000);return () => {alive = false;clearInterval(timer);};}, []);
  useEffect(() => {if(!retryUntil) return;setNow(Date.now());const timer = setInterval(() => setNow(Date.now()),1000);return () => clearInterval(timer);}, [retryUntil]);
  const retrySeconds = Math.max(0,Math.ceil((retryUntil - now) / 1000));
  useEffect(() => {setError('');setRetryTask(null);setRetryUntil(0);setLoginNeeded(false);}, [page]);
  useEffect(() => {let alive = true; load().catch(value => {if(alive) onError(value);}).finally(() => {if(alive) setLoading(false);}); const off = subscribeProgress(setProgress); return () => {alive = false; off();};}, [load,onError]);
  useEffect(() => {const listener = (event: KeyboardEvent) => {if((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select();} if(event.key === 'Escape' && !intent && !plan && !rootDialog) setSelected(undefined);}; window.addEventListener('keydown',listener); return () => window.removeEventListener('keydown',listener);}, [intent,plan,rootDialog]);
  useEffect(() => {const media = window.matchMedia('(prefers-color-scheme: dark)'); const apply = () => {const theme = data.settings.theme || 'light'; document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; document.documentElement.style.fontSize = `${data.settings.fontSize || 14}px`;}; apply();media.addEventListener('change',apply);return () => media.removeEventListener('change',apply);}, [data.settings.theme,data.settings.fontSize]);
  useEffect(() => {setListPage(1);}, [query,tool,scope,tag,state,favorites]);
  useEffect(() => {if(!toast) return; const timer = setTimeout(() => setToast(''),4500); return () => clearTimeout(timer);}, [toast]);
  const scan = () => run('正在扫描已登记的技能目录', async () => {const result = await call<Bootstrap>('scan'); setData({...INITIAL,...result}); setLastRefresh(new Date()); setToast(`扫描完成，共识别 ${result.skills?.length || 0} 个技能包`);});
  const selectSkill = useCallback(async (skill: Skill) => {
    setSelected(skill); setDetailLoading(true); const request = ++detailRequest.current;
    try {const detail = await call<Skill>('skills.detail',{id:skill.id}); if(request === detailRequest.current) {setSelected(detail);setData(previous => ({...previous,skills:previous.skills.map(item => item.id === detail.id ? {...item,...detail} : item)}));}}
    catch(value) {if(request === detailRequest.current) onError(value);} finally {if(request === detailRequest.current) setDetailLoading(false);}
  }, [onError]);
  const organize = (id: string, patch: any) => {void run('正在保存技能整理',async () => {const updated = await call<Skill>('skills.organize',{id,...patch}); setData(previous => ({...previous,skills:previous.skills.map(item => item.id === id ? {...item,...updated,...patch} : item)})); setSelected(previous => previous?.id === id ? {...previous,...updated,...patch} : previous); setToast('已保存');});};
  const go = (next: Page) => {setPage(next); if(next === 'tools' && tool === 'all') setTool('codex');};
  const projects = data.projects || data.settings.projects || [];
  const tags = useMemo(() => Array.from(new Set(data.skills.flatMap(skill => skill.tags || []))).sort((a,b) => a.localeCompare(b,'zh-CN')), [data.skills]);
  useEffect(() => {const timer=setInterval(() => setVersionNow(Date.now()),60000);return () => clearInterval(timer);}, []);
  const versionBySkill = useMemo(() => new Map(data.skills.map(skill => [skill.id,getSkillVersionStatus(skill,{tool:tool === 'all' ? undefined : tool,scope:scope === 'all' ? undefined : scope,now:versionNow})])), [data.skills,tool,scope,versionNow]);
  const filtered = useMemo(() => data.skills.filter(skill => {
    const text = `${skill.name} ${skill.alias || ''} ${skill.description || ''} ${skill.body || skill.raw || ''} ${(skill.tags || []).join(' ')}`.toLowerCase();
    return (!query.trim() || query.toLowerCase().split(/\s+/).every(word => text.includes(word)))
      && (tool === 'all' || skill.tools?.includes(tool as ToolId))
      && (scope === 'all' || skill.aliases?.some(item => item.scope === scope) || skill.deployments?.some(item => item.scope === scope))
      && (tag === 'all' || skill.tags?.includes(tag))
      && (!favorites || skill.favorite)
      && (state === 'all' || (state.startsWith('version:') ? matchesVersionFilter(versionBySkill.get(skill.id)!,state.slice(8)) : state === 'attention' ? !isHealthy(skill) : state === 'pinned' ? skill.pinned : skill.management === state));
  }).sort((a,b) => Number(!!b.favorite) - Number(!!a.favorite) || displayName(a).localeCompare(displayName(b),'zh-CN') || a.id.localeCompare(b.id)), [data.skills,query,tool,scope,tag,state,favorites,versionBySkill]);
  const pageCount = Math.max(1,Math.ceil(filtered.length / 40));
  const actualPage = Math.min(listPage,pageCount);
  const visible = filtered.slice((actualPage - 1) * 40,actualPage * 40);
  const allChecked = !!visible.length && visible.every(skill => selection.has(skill.id));
  const attentionCount = data.skills.filter(skill => !isHealthy(skill)).length;
  const favoriteCount = data.skills.filter(skill => skill.favorite).length;
  const associated = data.skills.reduce((sum,skill) => sum + (skill.tools?.length || 0),0);
  const pageTitle = page === 'settings' ? '设置' : NAV.find(item => item.id === page)?.title;
  const clearFilters = () => {setQuery('');setTool(page === 'tools' ? 'codex' : 'all');setScope('all');setTag('all');setState('all');setFavorites(false);};
  const toggle = (id: string) => setSelection(previous => {const next = new Set(previous); if(next.has(id)) next.delete(id);else next.add(id);return next;});
  const importFolder = async () => {await run('选择要导入的技能文件夹',async () => {const path = await call<string | null>('dialog.directory'); if(path) setIntent({kind:'import',sourcePath:path,name:path.split(/[\\/]/).pop()});});};
  const preparePlan = async (value: any) => {const result = await run('正在检查并生成操作预览', () => call<Plan>('operations.plan',value)); if(result) {setPlan(result);setIntent(null);}};
  const executePlan = async () => {if(!plan) return; await run('正在执行已确认的变更计划',async () => {const result = await call('operations.execute',{planId:plan.id,digest:plan.digest}); setPlan(null); await load(); setToast(['failed','partial','recovery-required'].includes(result.status) ? '操作存在未完成项目，请到操作历史查看结果' : '操作完成，可在操作历史中查看与恢复');});};
  const pageProps: PageProps = {data,busy,run,reload:load,onError,onIntent:setIntent,onSelect:selectSkill,onOrganize:organize};
  const listMode = page === 'skills' || page === 'tools';
  const adapter = data.adapters.find(item => item.tool === tool || item.id === tool);
  const checkTargets = selection.size ? filtered.filter(skill => selection.has(skill.id)) : filtered;
  const checkableTargets = checkTargets.filter(skill => versionBySkill.get(skill.id)?.canCheck);
  const checkVersions = async () => {
    setCheckNotice('');
    if (!checkableTargets.length) {
      setCheckNotice(selection.size && !checkTargets.length ? '当前筛选范围内没有选中的技能，请调整筛选或取消选择。' : checkTargets.length && checkTargets.every(skill => skill.pinned) ? '当前范围的技能均已固定版本，取消固定后可检查更新。' : '当前范围没有可核验的在线来源。请从已关联的公开来源安装技能后再检查；文件正常不代表版本最新。');
      return;
    }
    if (!data.github?.authenticated) {setPage('settings');return;}
    const skillIds = checkableTargets.map(skill => skill.id);
    const args = {skillIds,tool:tool === 'all' ? undefined : tool,scope:scope === 'all' ? undefined : scope};
    await run('正在检查当前范围的技能版本',async () => {
      const results = await call<any[]>('updates.check',args);
      await load();
      setToast('版本检查结果已更新，可在列表和“更新”页查看。');
      return results;
    }, {retryable:true});
  };
  useEffect(() => {setCheckNotice('');}, [tool,scope,query,state,selection]);


  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Layers3 size={25} strokeWidth={1.8}/></div><div><strong>Skillspace<span className="brand-dot">.</span></strong><span>技能管理器</span></div></div><div className="workspace-switch"><span className="workspace-icon"><Monitor size={16}/></span><span><strong>本地工作空间</strong><small>LOCAL WORKSPACE</small></span><ChevronDown size={14}/></div><div className="nav-caption">工作空间</div><nav aria-label="主导航">{NAV.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'selected' : ''}`} onClick={() => go(item.id)}><item.icon size={18}/><span>{item.title}</span>{item.id === 'skills' && <small>{data.skills.length}</small>}{item.id === 'updates' && !!data.updates?.filter(item => item.status === 'available').length && <small className="orange-count">{data.updates.filter(item => item.status === 'available').length}</small>}</button>)}</nav><div className="nav-divider"/><div className="nav-caption">快速访问</div><button className={`nav-item ${favorites && listMode ? 'favorite-selected' : ''}`} onClick={() => {setPage('skills');setFavorites(!favorites);}}><Star size={18}/><span>我的收藏</span><small>{favoriteCount}</small></button><button className="nav-item" onClick={() => {setPage('skills');setState('attention');}}><AlertCircle size={18}/><span>需要关注</span>{attentionCount > 0 && <small>{attentionCount}</small>}</button><div className="sidebar-grow"/><div className="local-card"><span className="local-dot"/><strong>数据留在本地</strong><p>清楚掌握每一份技能<br/>和每一次文件变更。</p><ShieldCheck size={31}/></div><button className={`nav-item settings-nav ${page === 'settings' ? 'selected' : ''}`} onClick={() => setPage('settings')}><Settings2 size={18}/><span>设置</span><span className="version-label">v0.1.2</span></button><div className="sidebar-footer"><span className="avatar">我</span><div><strong>我的技能工作台</strong><span>Windows 本地环境</span></div></div></aside>
    <div className="workspace-main">
      <header className="topbar"><div className="breadcrumbs"><span>工作空间</span><ChevronRight size={13}/><strong>{pageTitle}</strong></div><div className="global-search"><Search size={16}/><input ref={searchRef} aria-label="搜索本地技能" placeholder="搜索技能、描述或正文…" value={query} onChange={e => {setQuery(e.target.value);if(!listMode) setPage('skills');}}/>{query ? <IconButton title="清空搜索" onClick={() => setQuery('')}><X size={13}/></IconButton> : <kbd>Ctrl K</kbd>}</div><div className="topbar-actions"><IconButton title="重新扫描目录" disabled={busy || loading} onClick={scan}><RefreshCw size={18} className={busy && busyLabel.includes('扫描') ? 'spin' : ''}/></IconButton><span className="topbar-divider"/><span className="topbar-local"><span className="status-dot green"/>本地模式</span></div></header>
      <div className="workspace-body">
        <main className={`main-content ${selected && (listMode || page === 'duplicates') ? 'with-detail' : ''}`}>
          <div className="page-heading"><div><div className="page-eyebrow">{page === 'discover' ? 'EXPLORE & INSTALL' : page === 'settings' ? 'MAKE IT YOURS' : 'YOUR SKILL WORKSPACE'}</div><h1>{pageTitle}{favorites && listMode && <Badge tone="orange">收藏夹</Badge>}</h1><p>{page === 'skills' ? '把分散的技能，整理成得心应手的工具箱。' : page === 'tools' ? '了解每个工具能发现什么，以及技能存放在哪里。' : page === 'discover' ? '从公开来源中找到适合你的下一项技能。' : page === 'duplicates' ? '区分相同内容、目录链接与真正的版本差异。' : page === 'updates' ? '掌握来源变化，也保护你自己的修改。' : page === 'history' ? '每次文件变更都有记录，恢复之前先看清影响。' : '管理扫描范围、在线来源和使用偏好。'}</p></div>{listMode && <div className="heading-actions"><button className="button" disabled={busy} onClick={() => setRootDialog(true)}><Plus size={15}/>新增来源</button><button className="button primary" disabled={busy} onClick={importFolder}><ArrowDownToLine size={15}/>导入技能</button></div>}</div>
          {error && <div className="error-banner" role="alert"><AlertCircle size={18}/><div><strong>操作未完成</strong><p>{error}</p></div>{loginNeeded ? <button className="text-button" onClick={() => setPage('settings')}>前往登录</button> : retryTask && <button className="text-button" disabled={busy || retrySeconds > 0} onClick={() => {void run(retryTask.message,retryTask.task,{retryable:true});}}>{retrySeconds > 0 ? retrySeconds + ' 秒后重试' : '重试原操作'}</button>}<IconButton title="关闭错误提示" onClick={() => setError('')}><X size={15}/></IconButton></div>}
          {!!data.recovery?.length && <div className="recovery-banner"><History size={17}/><span>检测到 {data.recovery.length} 项中断操作，请检查操作历史并预览恢复。</span><button className="text-button" onClick={() => setPage('history')}>查看记录<ArrowRight size={13}/></button></div>}
          {listMode ? <>
            <section className="stats-grid" aria-label="技能统计"><Stat title="技能包" value={data.skills.length} icon={<Package size={19}/>} description="按物理内容计数"/><Stat title="工具关联" value={associated} icon={<Layers3 size={19}/>} description="支持多工具使用"/><Stat title="我的收藏" value={favoriteCount} icon={<Star size={19}/>} description="常用能力，随手可得"/><Stat title="需要关注" value={attentionCount} icon={<AlertCircle size={19}/>} description="文件或元数据异常" tone="orange"/></section>
            {page === 'tools' && <section className="tool-overview"><div className="tool-picker">{(Object.keys(TOOL_NAMES) as ToolId[]).map(id => <button key={id} className={tool === id ? 'selected' : ''} onClick={() => setTool(id)}><Terminal size={18}/><div><strong>{TOOL_NAMES[id]}</strong><span>{data.skills.filter(skill => skill.tools?.includes(id)).length} 个关联技能</span></div>{tool === id && <Check size={15}/>}</button>)}</div><div className="adapter-note"><CircleHelp size={16}/><div><strong>{TOOL_NAMES[tool]} 发现规则</strong><p>{adapter?.rule || adapter?.discoveryRules || adapter?.description || '读取用户级与已登记项目的技能目录。文件存在和配置启用分别记录，实际会话发现需要在对应工具中验证。'}</p><span className="muted small">工具版本：{adapter?.version || '未验证'} · 原生启停：{adapter?.capabilities?.toggle ? '支持' : '暂不提供配置写入'}</span></div></div></section>}
            <section className="skill-library">
              <div className="library-heading"><div className="inline"><h2>{favorites ? '收藏的技能' : '全部技能'}</h2><span className="count-pill">{filtered.length}</span></div><div className="library-check-actions"><span className="library-check-scope">{selection.size ? '当前筛选内选中' : '当前筛选'} {checkTargets.length} 项 · 可核验 {checkableTargets.length} 项</span><button className="button small-button" disabled={busy || loading} title={checkableTargets.length && !data.github?.authenticated ? '前往设置登录 GitHub 后检查更新' : selection.size ? '仅检查当前筛选范围内选中的技能' : '检查当前筛选范围内关联了在线来源的技能'} onClick={checkVersions}><RefreshCw size={14}/>{checkableTargets.length && !data.github?.authenticated ? '登录后检查更新' : '检查更新'}</button></div></div>
              {checkNotice && <div className="list-check-notice"><Notice>{checkNotice}</Notice></div>}
              <div className="filter-bar"><div className="filter-title"><ListFilter size={15}/>筛选</div><select aria-label="按工具筛选" value={tool} onChange={e => setTool(e.target.value)}><option value="all">全部工具</option>{Object.entries(TOOL_NAMES).map(([key,name]) => <option key={key} value={key}>{name}</option>)}</select><select aria-label="按范围筛选" value={scope} onChange={e => setScope(e.target.value)}><option value="all">全部范围</option><option value="user">用户级</option>{projects.map((item: any) => <option key={item.path || item} value={item.path || item}>{item.name || item.path || item}</option>)}</select><select aria-label="按标签筛选" value={tag} onChange={e => setTag(e.target.value)}><option value="all">全部标签</option>{tags.map(item => <option key={item}>{item}</option>)}</select><select aria-label="按状态筛选" value={state} onChange={e => setState(e.target.value)}><option value="all">全部状态</option><optgroup label="版本状态"><option value="version:current">最新版本</option><option value="version:available">有更新</option><option value="version:unchecked">待检查</option><option value="version:unknown-source">未知来源</option><option value="version:local-changed">本地改动</option><option value="version:check-failed">检查失败</option></optgroup><optgroup label="文件与管理"><option value="attention">需要关注</option><option value="managed">已纳管</option><option value="external">外部管理</option><option value="readonly">插件只读</option><option value="pinned">已固定版本</option></optgroup></select><IconButton title={favorites ? '显示全部技能' : '只看收藏'} active={favorites} onClick={() => setFavorites(!favorites)}><Star size={16} fill={favorites ? 'currentColor' : 'none'}/></IconButton></div>
              {!!selection.size && <div className="selection-toolbar"><span><CheckCheck size={16}/>已选择 <strong>{selection.size}</strong> 项</span><button className="text-button" onClick={() => setSelection(new Set())}>取消选择</button><button className="button primary small-button" disabled={busy || [...selection].some(id => {const skill = data.skills.find(item => item.id === id);return skill && isReadonly(skill);})} onClick={() => setIntent({kind:'install',skillIds:[...selection],name:`${selection.size} 个技能`})}><ArrowDownToLine size={13}/>批量安装</button></div>}
              <div className="list-columns"><label><input type="checkbox" checked={allChecked} aria-label="选择当前页所有技能" onChange={() => setSelection(previous => {const next = new Set(previous);visible.forEach(skill => allChecked ? next.delete(skill.id) : next.add(skill.id));return next;})}/><span>技能名称 / 用途</span></label><span>关联工具</span><span>版本状态</span><span/></div>
              {loading ? <Loading text="正在读取本地技能索引…"/> : visible.length ? <div className="skill-list">{visible.map(skill => <div className={`skill-row ${selected?.id === skill.id ? 'selected' : ''}`} key={skill.id}><input type="checkbox" aria-label={`选择 ${displayName(skill)}`} checked={selection.has(skill.id)} onChange={() => toggle(skill.id)}/><button className="skill-main" onClick={() => selectSkill(skill)}><div className={`skill-avatar ${skill.tools?.[0] || ''}`}>{skill.favorite ? <Star size={20}/> : <FileText size={20}/>}</div><div className="skill-copy"><div className="skill-name"><strong>{displayName(skill)}</strong>{skill.alias && <span>{skill.name}</span>}{skill.pinned && <Badge>已固定</Badge>}</div><p>{skill.description || '暂无描述，点击查看技能内容'}</p><div className="skill-meta"><span>{label(skill.management)}</span><span className="meta-dot">·</span><span>{skill.aliases && skill.aliases.length > 1 ? `${skill.aliases.length} 个发现入口` : skill.physicalPath?.split(/[\\/]/).slice(-2).join('/') || '本地技能'}</span>{skill.tags?.slice(0,2).map(item => <span className="tag-chip" key={item}>{item}</span>)}</div></div></button><div className="row-tools"><ToolBadges tools={skill.tools}/></div><VersionCell skill={skill} version={versionBySkill.get(skill.id)!}/><IconButton title={skill.favorite ? '取消收藏' : '收藏技能'} className="row-star" active={skill.favorite} disabled={busy} onClick={() => organize(skill.id,{favorite:!skill.favorite})}><Star size={16} fill={skill.favorite ? 'currentColor' : 'none'}/></IconButton></div>)}</div> : <Empty icon={data.skills.length ? <Search size={32}/> : <Package size={32}/>} title={data.skills.length ? '没有找到匹配的技能' : '你的技能工作台，准备就绪'} description={data.skills.length ? '试试其他关键词，或清除筛选条件查看全部技能。' : '扫描已发现的工具目录，或添加你的技能文件夹，建立第一份清晰的技能索引。'} action={data.skills.length ? <button className="button" onClick={clearFilters}>清除筛选</button> : <button className="button primary" disabled={busy} onClick={scan}><RefreshCw size={15}/>开始扫描</button>}/>}<div className="list-footer"><span>显示 {filtered.length ? (actualPage - 1) * 40 + 1 : 0}–{Math.min(actualPage * 40,filtered.length)} 项，共 {filtered.length} 项</span><div className="inline"><IconButton title="上一页" disabled={actualPage <= 1} onClick={() => setListPage(actualPage - 1)}><ChevronLeft size={15}/></IconButton><span>{actualPage} / {pageCount}</span><IconButton title="下一页" disabled={actualPage >= pageCount} onClick={() => setListPage(actualPage + 1)}><ChevronRight size={15}/></IconButton></div></div>
            </section><div className="list-bottom-note"><ShieldCheck size={13}/>只读扫描不会移动、修改或删除你的技能文件。</div>
          </> : page === 'discover' ? <Discovery {...pageProps}/> : page === 'duplicates' ? <Duplicates {...pageProps}/> : page === 'updates' ? <Updates {...pageProps}/> : page === 'history' ? <HistoryPage {...pageProps}/> : <SettingsPage {...pageProps}/>}
        </main>
        {(listMode || (page === 'duplicates' && selected)) && <Detail skill={selected} loading={detailLoading} busy={busy} onClose={() => {++detailRequest.current;setSelected(undefined);setDetailLoading(false);}} onError={onError} onOrganize={organize} onIntent={setIntent}/>}
      </div>
      <footer className={`taskbar ${busy ? 'working' : ''}`} role="status"><div>{busy ? <Loader2 size={13} className="spin"/> : error ? <AlertCircle size={13}/> : <Check size={13}/>}<span>{busy ? progress?.message || busyLabel : error ? '最近一次操作未完成，请查看上方提示' : '就绪'}</span>{busy && progress?.total ? <span>{progress.current || 0} / {progress.total}</span> : null}</div>{busy && progress?.total ? <progress max={progress.total} value={progress.current || 0}/> : <span>{data.roots.length} 个扫描目录{lastRefresh ? ` · 索引读取于 ${lastRefresh.toLocaleTimeString('zh-CN',{hour12:false})}` : ''}</span>}</footer>
    </div>
    {toast && <div className="toast" role="status"><Check size={16}/>{toast}<IconButton title="关闭通知" onClick={() => setToast('')}><X size={14}/></IconButton></div>}
    {intent && <IntentDialog intent={intent} projects={projects} busy={busy} onClose={() => setIntent(null)} onSubmit={preparePlan}/>}
    {plan && <Modal title="确认文件变更" subtitle="请核对目标位置与影响范围，确认后执行。" wide onClose={() => {if(!busy) setPlan(null);}} footer={<><span className="muted small">{plan.steps?.length || 0} 项变更 · 保留操作记录与恢复快照</span><div className="inline"><button className="button" disabled={busy} onClick={() => setPlan(null)}>返回</button><button className="button primary" disabled={busy || !!plan.blockers?.length || !plan.steps?.length} onClick={executePlan}>{busy ? <Loader2 size={15} className="spin"/> : <Check size={15}/>}确认执行</button></div></>}><div className="plan-summary"><span className="mini-symbol"><FileText size={21}/></span><div><strong>{typeof plan.summary === 'string' ? plan.summary : '操作变更计划'}</strong><span>计划已生成；执行时会再次检查文件是否变化。</span></div></div>{plan.blockers?.map((item,index) => <Notice key={index} tone="error">{typeof item === 'string' ? item : item.message}{item.details && <pre className="wrap-code">{JSON.stringify(item.details,null,2)}</pre>}</Notice>)}{plan.warnings?.map((item,index) => <Notice key={index} tone="warning">{typeof item === 'string' ? item : item.message}</Notice>)}<div className="plan-steps">{plan.steps?.map((step,index) => <div className="plan-step" key={index}><div className="space-between"><Badge tone="orange">{label(step.action || step.kind)}</Badge><ToolBadges tools={step.tools || (step.tool ? [step.tool] : [])}/><span className="muted small">{step.scope === 'user' ? '用户级' : step.scope ? '项目级' : '集中库'} · {bytes(step.bytes)}</span></div>{step.sourcePath && <div className="plan-path"><span>来源</span><code>{step.sourcePath}</code></div>}<div className="plan-path"><span>目标</span><code>{step.targetPath}</code></div>{step.beforeHash && <div className="muted small">包含已有内容快照</div>}</div>)}</div></Modal>}
    {rootDialog && <Modal title="新增扫描来源" subtitle="添加一个本地技能目录，保留现有文件位置。" onClose={() => setRootDialog(false)} footer={<><button className="button" onClick={() => setRootDialog(false)}>取消</button><button className="button primary" disabled={busy || !rootPath.trim()} onClick={() => run('正在添加扫描来源',async () => {await call('roots.add',{path:rootPath.trim(),kind:rootKind,tools:[],scope:'user'});await load();setRootDialog(false);setRootPath('');setToast('来源已添加，可以开始扫描');})}>添加来源</button></>}><label className="field-label">目录路径<div className="inline"><input className="grow" placeholder="选择或输入技能目录路径" value={rootPath} onChange={e => setRootPath(e.target.value)}/><button className="button" disabled={busy} onClick={() => run('选择扫描目录',async () => {const path = await call('dialog.directory');if(path) setRootPath(path);})}><FolderOpen size={15}/>选择</button></div></label><label className="field-label">目录用途<select value={rootKind} onChange={e => setRootKind(e.target.value)}><option value="candidate">候选技能库</option><option value="active">工具目录</option><option value="backup">备份目录</option><option value="history">历史记录</option></select></label><Notice>备份和历史目录会单独标注，不能直接视为工具已经安装的技能。</Notice></Modal>}
  </div>;
}


function matchesVersionFilter(version: ReturnType<typeof getSkillVersionStatus>, filter: string): boolean {
  if (filter === 'current') return version.status === 'current';
  const states = [version.status,...(version.states || []).map(item => item.status)];
  if (filter === 'available') return states.some(status => ['available','both-changed'].includes(status));
  if (filter === 'local-changed') return states.some(status => ['local-changed','both-changed'].includes(status));
  if (filter === 'unchecked') return states.some(status => ['unchecked','stale','incomplete'].includes(status));
  return states.some(status => status === filter);
}

function VersionCell({skill,version}: {skill: Skill; version: ReturnType<typeof getSkillVersionStatus>}) {
  return <div className="row-status"><span className={'version-state-label ' + version.status} title={version.description} tabIndex={0} aria-label={'版本状态：' + version.label + '。' + version.description}><span className="status-dot"/>{version.label}</span><span className={'version-health ' + (isHealthy(skill) ? '' : 'attention')} title={isHealthy(skill) ? '技能文件完整可读；版本状态由来源检查单独判断。' : '文件或元数据需要检查'}>{isHealthy(skill) ? '文件正常' : label(skill.health)}</span><span className="config-label">{label(skill.configState)}</span></div>;
}

function Stat({title,value,icon,description,tone = ''}: {title: string; value: number; icon: React.ReactNode; description: string; tone?: string}) {return <div className={`stat-card ${tone}`}><div className="space-between"><span>{title}</span><span className="stat-icon">{icon}</span></div><strong>{value.toLocaleString()}</strong><small>{description}</small></div>;}

function IntentDialog({intent,projects,busy,onClose,onSubmit}: {intent: Intent; projects: any[]; busy: boolean; onClose: () => void; onSubmit: (value: any) => void}) {
  const [tools, setTools] = useState<ToolId[]>(intent.kind === 'import' ? [] : ['codex']);
  const [scope, setScope] = useState('user');
  const [force, setForce] = useState(!!intent.force);
  const [deploymentId, setDeploymentId] = useState(intent.deploymentId || intent.deployments?.[0]?.id || '');
  const targetAction = ['install','import'].includes(intent.kind);
  const submit = () => {const {deployments,...rest} = intent;onSubmit({...rest,kind:intent.kind === 'import' && tools.length ? 'install' : intent.kind,force,deploymentId:deploymentId || undefined,targets:targetAction ? tools.map(tool => ({tool,scope})) : intent.targets || []});};
  return <Modal title={`${label(intent.kind)}${intent.name ? ` · ${intent.name}` : ''}`} subtitle={targetAction ? '选择工具与使用范围，下一步将展示具体文件变更。' : '下一步检查当前文件，生成可核对的变更计划。'} onClose={() => {if(!busy) onClose();}} footer={<><span className="muted small">此步骤不会修改文件</span><button className="button primary" disabled={busy || (intent.kind === 'install' && !tools.length) || (intent.kind === 'remove' && !deploymentId)} onClick={submit}>生成变更预览<ArrowRight size={15}/></button></>}>
    {intent.sourcePath && <div className="intent-source"><span className="section-eyebrow">技能来源</span><code>{intent.sourcePath}</code></div>}
    {targetAction && <><div className="section-eyebrow">目标工具 {intent.kind === 'import' && <span className="muted">· 不选工具时仅导入集中库</span>}</div><div className="target-options">{(Object.keys(TOOL_NAMES) as ToolId[]).map(tool => <label key={tool} className={tools.includes(tool) ? 'selected' : ''}><input type="checkbox" checked={tools.includes(tool)} onChange={() => setTools(previous => previous.includes(tool) ? previous.filter(item => item !== tool) : [...previous,tool])}/><Terminal size={21}/><strong>{TOOL_NAMES[tool]}</strong>{tools.includes(tool) && <Check size={15}/>}</label>)}</div>{!!tools.length && <label className="field-label">安装范围<select value={scope} onChange={e => setScope(e.target.value)}><option value="user">用户级 · 当前用户的所有项目</option>{projects.map(project => <option value={project.path || project} key={project.id || project.path || project}>项目 · {project.name || project.path || project}</option>)}</select></label>}<Notice>每个工具的目标目录会在下一步展开。安装完成后，请在对应工具中刷新或开启新会话。</Notice></>}
    {intent.kind === 'remove' && <><Notice tone="warning">仅移除选定的受管理安装。若目标被其他工具共享，预览会显示全部已知影响。</Notice>{intent.deployments?.map(item => <label className="remove-target" key={item.id}><input type="radio" name="deployment" value={item.id} checked={deploymentId === item.id} onChange={() => setDeploymentId(item.id)}/><div><strong>{TOOL_NAMES[item.tool] || item.tool} · {item.scope === 'user' ? '用户级' : item.scope}</strong><code>{item.targetPath}</code></div></label>)}</>}
    {intent.kind === 'remove' && <label className="check-line"><input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)}/><span>若本地文件有修改，保存当前内容快照后移除</span></label>}
    {intent.kind === 'update' && <Notice tone={intent.force ? 'warning' : 'info'}>{intent.force ? '本地内容已有修改。更新会先保存当前内容的恢复快照，再替换为所选远端版本。' : '当前安装将更新到已预览的远端内容，并保留旧版本恢复记录。'}</Notice>}
    {intent.kind === 'restore' && <><Notice>恢复前会重新检查目标。操作之后的修改会阻止常规恢复；可以选择先保存当前内容，再恢复。</Notice><label className="check-line"><input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)}/><span>若存在后续修改，先保存当前内容快照再恢复</span></label></>}
  </Modal>;
}
