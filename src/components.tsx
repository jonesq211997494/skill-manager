import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, FolderOpen, Info, Loader2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { call, errorText } from './api';
import { TOOL_NAMES, type ToolId } from './types';

export function IconButton({title, children, onClick, active, disabled, className = ''}: {title: string; children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean; className?: string}) {
  return <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className={`icon-button ${active ? 'active' : ''} ${className}`}>{children}</button>;
}
export function Badge({children, tone = ''}: {children: ReactNode; tone?: string}) { return <span className={`badge ${tone}`}>{children}</span>; }
export function ToolBadges({tools = []}: {tools?: ToolId[]}) {return <span className="tool-badges">{tools.length ? tools.map(tool => <span key={tool} className={`tool-badge ${tool}`}>{TOOL_NAMES[tool] || tool}</span>) : <span className="muted small">未关联工具</span>}</span>;}
export function Empty({icon, title, description, action}: {icon: ReactNode; title: string; description: string; action?: ReactNode}) {
  return <div className="empty-state"><div className="empty-symbol">{icon}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function Notice({children, tone = 'info'}: {children: ReactNode; tone?: 'info'|'warning'|'error'|'success'}) {
  return <div className={`notice ${tone}`}>{tone === 'success' ? <Check size={16}/> : tone === 'error' || tone === 'warning' ? <AlertCircle size={16}/> : <Info size={16}/>}<div>{children}</div></div>;
}
export function Loading({text = '正在读取…'}: {text?: string}) {return <div className="loading"><Loader2 className="spin" size={19}/><span>{text}</span></div>;}
export function Modal({title, subtitle, children, footer, onClose, wide = false}: {title: string; subtitle?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]') || []);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
      }
    };
    document.addEventListener('keydown', listener);
    return () => { document.removeEventListener('keydown', listener); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => {if(event.target === event.currentTarget) onClose();}}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide' : ''}`}><header className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton title="关闭弹窗" onClick={onClose}><X size={19}/></IconButton></header><div className="modal-body">{children}</div>{footer && <footer className="modal-footer">{footer}</footer>}</div></div>;
}
export function Markdown({text}: {text: string}) {
  const [linkError,setLinkError] = useState('');
  return <div className="markdown">{linkError && <Notice tone="error">{linkError}</Notice>}<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a: ({href, children}) => <a href={/^https?:\/\//i.test(href || '') ? href : undefined} onClick={event => {event.preventDefault(); if(/^https?:\/\//i.test(href || '')) {setLinkError(''); void call('links.open',{url:href}).catch(value => setLinkError(errorText(value)));}}}>{children}</a>, img: ({alt}) => <span className="image-placeholder">图片：{alt || '外部图片'}</span>}}>{text}</ReactMarkdown></div>;
}
export function PathLine({path, onError, showOpen = true}: {path: string; onError: (error: unknown) => void; showOpen?: boolean}) {
  return <div className="path-line"><code title={path}>{path}</code><IconButton title="复制路径" onClick={() => {navigator.clipboard.writeText(path).catch(onError);}}><Copy size={13}/></IconButton>{showOpen && <IconButton title="打开目录" onClick={() => {call('files.open', {path}).catch(onError);}}><FolderOpen size={14}/></IconButton>}</div>;
}
export function bytes(value: number = 0): string {return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;}
export function shortHash(value?: string): string {return value ? value.slice(0, 12) : '暂无记录';}
export function dateTime(value: any): string {if (!value) return '时间未知'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', {hour12: false});}
