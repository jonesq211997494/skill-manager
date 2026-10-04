import { useEffect, useState } from 'react';
import { ArrowLeft, Check, FileDiff, Github, Link2, Loader2, Search, Unlink } from 'lucide-react';
import { call, errorText, requiresGitHubLogin, type RunTask } from './api';
import { Badge, Empty, Modal, Notice, shortHash } from './components';
import { CacheState } from './GitHubAccount';
import { displayName, type Skill } from './types';
import { hasVersionSource } from '../shared/version-status.mjs';

type BindingPreview = {id: string; skillId: string; name: string; source: any; localHash: string; remoteHash: string; identical: boolean; files: {path: string; status: string}[]; warnings: string[]; checkedAt: string};
type Props = {skill: Skill; busy: boolean; run: RunTask; onReload: () => Promise<void>; onLogin: () => void};

function repositoryName(source: any): string {
  const repository = source?.repository;
  if (typeof repository === 'string') return repository;
  return source?.fullName || repository?.fullName || (repository?.owner && repository?.repo ? repository.owner + '/' + repository.repo : '') || (source?.owner && source?.repo ? source.owner + '/' + source.repo : source?.url || repository?.url || '公开 GitHub 来源');
}
function SourceFields({source}: {source: any}) {
  return <dl className="source-binding-fields"><div><dt>仓库</dt><dd>{repositoryName(source)}</dd></div><div><dt>分支 / 标签</dt><dd>{source?.ref || '默认分支'}</dd></div><div><dt>技能目录</dt><dd>{source?.subdir || source?.path || '仓库根目录'}</dd></div></dl>;
}
function diffLabel(status: string): string {
  return ({added:'仅来源包含',deleted:'仅本地包含',modified:'内容不同',unchanged:'内容一致',changed:'内容不同'} as Record<string,string>)[status] || status;
}

export default function SourceBinding({skill,busy,run,onReload,onLogin}: Props) {
  const [open,setOpen] = useState(false);
  const [unlinking,setUnlinking] = useState(false);
  const [url,setUrl] = useState('');
  const [ref,setRef] = useState('');
  const [repository,setRepository] = useState<any>();
  const [preview,setPreview] = useState<BindingPreview>();
  const [pending,setPending] = useState('');
  const [cancelling,setCancelling] = useState(false);
  const [message,setMessage] = useState('');
  const [failure,setFailure] = useState('');
  const [needsLogin,setNeedsLogin] = useState(false);
  useEffect(() => {setOpen(false);setUnlinking(false);setRepository(undefined);setPreview(undefined);setUrl('');setRef('');setFailure('');setMessage('');}, [skill.id]);
  const binding = skill.sourceBinding;
  const installationSource = skill.deployments?.find(item => hasVersionSource(item.source))?.source;
  const reset = () => {setFailure('');setMessage('');setNeedsLogin(false);};
  const query = async <T,>(kind: string, title: string, task: () => Promise<T>) => {
    setPending(kind);reset();
    try {
      return await run(title,async () => {
        try {return await task();}
        catch(value) {
          if ((value as any)?.code === 'CANCELLED') setMessage('读取已取消，尚未保存关联。');
          else {setFailure(errorText(value));setNeedsLogin(requiresGitHubLogin(value));}
          throw value;
        }
      }, {cancellable:kind === 'inspect' || kind === 'preview'});
    } finally {setPending('');setCancelling(false);}
  };
  const inspect = async () => {
    const targetUrl = url.trim();
    if (!targetUrl || busy) return;
    await query('inspect','正在查找可关联的在线技能',async () => {
      const result = await call('skills.source.inspect',{id:skill.id,url:targetUrl,ref:ref.trim() || undefined});
      setRepository(result);setPreview(undefined);return result;
    });
  };
  const compare = async (candidate: any) => {
    await query('preview','正在比较本地技能与在线来源',async () => {
      const result = await call<BindingPreview>('skills.source.preview',{id:skill.id,candidate:{...candidate,repository:repository.repository,ref:repository.ref,commit:repository.commit}});
      setPreview(result);return result;
    });
  };
  const bind = async () => {
    if (!preview) return;
    await query('bind','正在保存在线来源关联',async () => {
      const result = await call('skills.source.bind',{previewId:preview.id});
      await onReload();setOpen(false);setPreview(undefined);setMessage('已保存来源关联，原文件保持原样。');return result;
    });
  };
  const unbind = async () => {
    await query('unbind','正在解除在线来源关联',async () => {
      const result = await call('skills.source.unbind',{id:skill.id});
      await onReload();setUnlinking(false);setMessage('已解除来源关联，原文件保持原样。');return result;
    });
  };
  const cancelRead = async () => {
    setCancelling(true);
    try {const result = await call<{cancelled: boolean; message: string}>('jobs.cancel',{id:'download'});if(!result.cancelled) {setMessage(result.message || '当前读取已结束。');setCancelling(false);}}
    catch(value) {setFailure(errorText(value));setCancelling(false);}
  };
  const close = () => {if(!busy) {setOpen(false);reset();}};
  return <section className="detail-section source-binding"><div className="section-eyebrow">在线来源</div>
    {binding ? <><SourceFields source={binding.source}/><p className="muted small">仅跟踪 · 原文件由外部工具管理</p><div className="source-binding-actions"><button className="text-button" disabled={busy} onClick={() => {reset();setUrl(binding.source?.url || '');setRef(binding.source?.ref || '');setRepository(undefined);setPreview(undefined);setOpen(true);}}><Link2 size={13}/>更换来源关联</button><button className="text-button" disabled={busy} onClick={() => {reset();setUnlinking(true);}}><Unlink size={13}/>解除关联</button></div></> : installationSource ? <><SourceFields source={installationSource}/><p className="muted small">来源保存在受管理的安装记录中。</p></> : <><p className="muted small">为这份本地技能关联公开 GitHub 来源，以比较内容和跟踪变化。</p><button className="button small-button" disabled={busy} onClick={() => {reset();setRepository(undefined);setPreview(undefined);setOpen(true);}}><Link2 size={14}/>关联在线来源</button></>}
    {!open && !unlinking && message && <p className="muted small" role="status">{message}</p>}
    {open && <Modal title={'关联在线来源 · ' + displayName(skill)} subtitle="关联只保存来源信息，不会移动或覆盖本地文件。" wide onClose={close} footer={<><span className="muted small">{preview ? '请核对来源和文件差异，再保存关联。' : '先选择仓库中的一个技能，再比较内容。'}</span><div className="inline">{(pending === 'inspect' || pending === 'preview') && <button className="button" disabled={cancelling} onClick={cancelRead}>{cancelling ? '正在取消…' : '取消读取'}</button>}<button className="button" disabled={busy} onClick={close}>关闭</button>{preview && <button className="button primary" disabled={busy} onClick={bind}><Check size={14}/>确认保存关联</button>}</div></>}>
      {failure && <Notice tone="error">{failure}{needsLogin && <button className="text-button" disabled={busy} onClick={() => {setOpen(false);onLogin();}}>前往设置登录</button>}</Notice>}
      {message && <Notice>{message}</Notice>}
      {preview ? <><button className="text-button" disabled={busy} onClick={() => {setPreview(undefined);reset();}}><ArrowLeft size={14}/>重新选择技能</button><h3 className="source-preview-title">{preview.name}</h3><SourceFields source={preview.source}/><Notice tone={preview.identical ? 'info' : 'warning'}>{preview.identical ? '本地内容与本次读取的来源内容一致。' : '本地内容与来源不同；缺少安装基线，不能据此判断本地版本过时。'} 保存后仅跟踪来源，原文件仍由当前工具管理。</Notice>{preview.warnings?.map((warning,index) => <Notice key={index} tone="warning">{warning}</Notice>)}<div className="source-hash-comparison"><div><span>本地内容</span><code>{shortHash(preview.localHash)}</code></div><div><span>来源内容</span><code>{shortHash(preview.remoteHash)}</code></div></div><div className="source-file-diff"><div className="space-between"><h3>文件差异</h3><Badge>{preview.files?.length || 0} 项</Badge></div>{preview.files?.map(file => <div className="file-row" key={file.path}><FileDiff size={14}/><span>{file.path}</span><Badge>{diffLabel(file.status)}</Badge></div>)}{!preview.files?.length && <p className="muted small">没有记录到文件差异。</p>}</div></> : <><form className="source-binding-form" onSubmit={event => {event.preventDefault();void inspect();}}><label className="field-label">GitHub 仓库 / 技能目录链接<input aria-label="关联来源链接" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" disabled={busy}/></label><label className="field-label">分支 / 标签 / 提交（可选）<input aria-label="关联来源分支" value={ref} onChange={event => setRef(event.target.value)} placeholder="留空使用默认分支" disabled={busy}/></label><button className="button primary" disabled={busy || !url.trim()}>{pending === 'inspect' ? <Loader2 size={14} className="spin"/> : <Search size={14}/>}查找技能</button></form>{repository && <div className="source-candidate-list"><div className="space-between"><h3><Github size={16}/> {repositoryName({repository:repository.repository})}</h3><Badge>{repository.skills?.length || 0} 个技能</Badge></div><CacheState value={repository}/>{repository.warning && <Notice tone="warning">{repository.warning}</Notice>}{repository.skills?.length ? repository.skills.map((candidate: any) => <div className="candidate-row" key={candidate.path || candidate.name}><div className="grow"><strong>{candidate.name}</strong><p className="muted small">{candidate.path || '仓库根目录'}</p></div><button className="button small-button" disabled={busy} onClick={() => compare(candidate)}><FileDiff size={13}/>比较这个技能</button></div>) : <Empty icon={<Github size={26}/>} title="此位置没有可关联的技能" description="来源需要包含 SKILL.md，可尝试其他分支或目录。"/>}</div>}</>}
    </Modal>}
    {unlinking && <Modal title="解除在线来源关联" subtitle={displayName(skill)} onClose={() => {if(!busy) setUnlinking(false);}} footer={<><button className="button" disabled={busy} onClick={() => setUnlinking(false)}>返回</button><button className="button primary" disabled={busy} onClick={unbind}>确认解除关联</button></>}><Notice>只清除管理器保存的来源关联与检查记录，不删除或修改原技能文件。</Notice>{binding && <SourceFields source={binding.source}/>} {failure && <Notice tone="error">{failure}</Notice>}</Modal>}
  </section>;
}
