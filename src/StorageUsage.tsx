import { useEffect, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { call, type RunTask } from './api';
import { Badge, bytes, Notice } from './components';

type Category = {id: string; name: string; bytes: number; files: number; directories: number; complete: boolean};
type Usage = {totalBytes: number; backupBytes: number; limitBytes: number; overLimit: boolean; complete: boolean; categories: Category[]; issues: any[]};
export default function StorageUsage({busy,run,limitGB}: {busy: boolean; run: RunTask; limitGB: number}) {
  const [usage,setUsage] = useState<Usage>();
  const [checkedAt,setCheckedAt] = useState('');
  useEffect(() => {setUsage(undefined);setCheckedAt('');}, [limitGB]);
  const refresh = () => run('正在统计管理器存储用量',async () => {
    const result = await call<Usage>('storage.usage');
    setUsage(result);setCheckedAt(new Date().toLocaleString('zh-CN', {hour12:false}));return result;
  }, {retryable:true});
  const percentage = usage && usage.limitBytes > 0 ? Math.min(100,usage.backupBytes / usage.limitBytes * 100) : 0;
  return <section className="card settings-card storage-usage"><div className="settings-heading"><Database size={19}/><div className="grow"><h3>存储用量</h3><p>统计范围：应用数据目录内的集中库、缓存和恢复快照；不包含整台电脑或目录外的自定义库。</p></div><button className="button small-button" disabled={busy} onClick={refresh}><RefreshCw size={14}/>{usage ? '刷新用量' : '统计用量'}</button></div>
    {!usage ? <p className="muted small">尚未统计。点击“统计用量”查看实际占用与备份容量提醒。</p> : <><div className="storage-summary"><div><span>应用数据已统计占用</span><strong>{bytes(usage.totalBytes)}</strong></div><div><span>备份快照</span><strong>{bytes(usage.backupBytes)}</strong></div><div><span>备份提醒阈值</span><strong>{bytes(usage.limitBytes)}</strong></div></div><div className={'storage-meter' + (usage.overLimit ? ' over-limit' : '')} role="meter" aria-label="备份容量阈值占用比例" aria-valuenow={Math.round(percentage)} aria-valuemin={0} aria-valuemax={100}><span style={{width:percentage + '%'}}/></div>{usage.overLimit && <Notice tone="warning">备份快照已达到容量提醒阈值（{bytes(usage.backupBytes)} / {bytes(usage.limitBytes)}）。请核对需要保留的恢复记录；程序不会自动删除快照。</Notice>}{!usage.complete && <Notice tone="warning">部分目录未能完整统计，当前显示的是已确认的占用，实际用量可能更高。</Notice>}<div className="storage-categories" role="table" aria-label="存储分类用量"><div className="storage-category header" role="row"><span role="columnheader">分类</span><span role="columnheader">占用</span><span role="columnheader">文件 / 目录</span><span role="columnheader">统计状态</span></div>{usage.categories.map(category => <div className="storage-category" role="row" key={category.id}><span role="cell">{category.name}</span><strong role="cell">{bytes(category.bytes)}</strong><span role="cell">{category.files} / {category.directories}</span><span role="cell"><Badge tone={category.complete ? '' : 'warning'}>{category.complete ? '完整' : '部分'}</Badge></span></div>)}</div>{!!usage.issues?.length && <details className="storage-issues"><summary>查看未完整统计的原因（{usage.issues.length}）</summary>{usage.issues.map((issue,index) => <p className="muted small" key={index}>{typeof issue === 'string' ? issue : [issue.path,issue.message || issue.reason || issue.code].filter(Boolean).join('：')}</p>)}</details>}<p className="muted small storage-checked-at">统计于 {checkedAt} · 阈值按已保存的设置计算。</p></>}
  </section>;
}
