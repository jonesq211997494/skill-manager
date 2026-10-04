import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Github, KeyRound, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import { call, errorText, errorRetryAt, timestamp } from './api';
import { Badge, Notice } from './components';
import type { GitHubStatus } from './types';

export function CacheState({value}: {value: any}) {
  if (!value?.cachedAt && !value?.fromCache && !value?.stale) return null;
  return <div className="cache-state"><Badge tone={value.stale ? 'warning' : ''}>{value.stale ? '较早缓存' : value.fromCache ? '来自缓存' : '刚刚获取'}</Badge>{value.cachedAt && <span>获取于 {new Date(value.cachedAt).toLocaleString('zh-CN', {hour12:false})}</span>}{value.stale && <span>内容可能不是最新。</span>}</div>;
}

export default function GitHubAccount({status, reload, compact = false}: {status?: GitHubStatus; reload: () => Promise<void>; compact?: boolean}) {
  const [expanded, setExpanded] = useState(!compact);
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [pending, setPending] = useState<'browser' | 'token' | 'logout' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const [started, setStarted] = useState(0);
  const [retryUntil, setRetryUntil] = useState(0);
  const request = useRef(0);
  const active = useRef(false);
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()),1000); return () => {clearInterval(timer); request.current += 1;};}, []);
  useEffect(() => {setToken('');setError('');}, [status?.user?.id]);
  useEffect(() => {if(!notice) return;const timer = setTimeout(() => setNotice(''),4500);return () => clearTimeout(timer);}, [notice]);
  const authenticate = async (method: 'browser' | 'token') => {
    if (active.current || !status?.storageAvailable || Date.now() < retryUntil) return;
    const secret = token.trim();
    const login = username.trim();
    setToken(''); setError(''); setNotice('');
    if (method === 'token' && !secret) return;
    if (method === 'browser' && !login) return;
    active.current = true; const id = ++request.current;
    setPending(method); setStarted(Date.now());
    try {
      await call(method === 'token' ? 'github.loginToken' : 'github.loginBrowser', method === 'token' ? {token:secret} : {username:login});
      if (id !== request.current) return;
      await reload();
      setNotice('已登录。可以发起搜索、预览或检查更新。');
      if (compact) setExpanded(false);
    } catch (value) {if (id === request.current) {setError(errorText(value));setRetryUntil(errorRetryAt(value));}}
    finally {if (id === request.current) {active.current = false;setPending(null);}}
  };
  const cancel = async () => {
    request.current += 1; setToken('');
    try {await call('github.cancelLogin');setNotice('已取消登录。');}
    catch (value) {setError(errorText(value));}
    finally {active.current = false;setPending(null);await reload().catch(() => {});}
  };
  const logout = async () => {
    if (active.current) return;
    active.current = true;setPending('logout');setError('');setNotice('');setToken('');
    try {await call('github.logout');await reload();setNotice('已退出技能管理器。系统中其他 Git 工具的登录保持原样。');}
    catch (value) {setError(errorText(value));}
    finally {active.current = false;setPending(null);}
  };
  const authenticated = !!status?.authenticated;
  const loginCooldown = Math.max(0,Math.ceil((retryUntil - now) / 1000));
  const loginDisabled = !!pending || !status?.storageAvailable || loginCooldown > 0;
  const cooling = Math.max(0, Math.ceil((timestamp(status?.rateLimits?.cooldownUntil) - now) / 1000));
  return <section className={'card settings-card github-account' + (compact ? ' compact' : '') + (compact && !expanded ? ' collapsed' : '')} aria-label="GitHub 账号">
    <div className="github-account-summary"><div className="settings-heading"><Github size={21}/><div className="grow"><h3>GitHub 账号 {authenticated && <Badge tone="success">已登录</Badge>}</h3><p>{authenticated ? '@' + status?.user?.login + (status?.user?.name ? ' · ' + status.user.name : '') : '登录后使用在线搜索、技能预览和更新。本地技能管理始终可用。'}</p></div>{compact && <button className="button small-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起账号设置' : authenticated ? '管理账号' : '登录 GitHub'}</button>}</div>
    {authenticated && <div className="github-quotas" aria-label="GitHub 请求额度">{(['core','search'] as const).map(key => {
      const limit = status?.rateLimits?.resources?.[key];
      const reset = timestamp(limit?.reset);
      const wait = Math.max(0,Math.ceil((timestamp(limit?.cooldownUntil || limit?.retryAt || (limit?.remaining === 0 ? limit.reset : undefined)) - now) / 1000));
      return <div key={key} title={reset ? new Date(reset).toLocaleTimeString('zh-CN', {hour12:false}) + ' 重置' : '随实际请求更新额度'}><span>{key === 'core' ? '仓库与文件' : '仓库搜索'}</span><strong>{limit?.remaining == null ? '尚无记录' : limit.remaining + ' / ' + (limit.limit ?? '—')}</strong><small className="quota-reset">{reset ? new Date(reset).toLocaleTimeString('zh-CN', {hour12:false}) + ' 重置' : '随实际请求更新额度'}</small>{wait > 0 && <small className="quota-cooldown">约 {wait} 秒后恢复此类请求</small>}</div>;
    })}<p className="muted small">额度来自最近一次 GitHub 响应；查看此状态不消耗请求额度。</p></div>}</div>
    {cooling > 0 && <Notice tone="warning">GitHub 暂时限制请求，约 {cooling} 秒后可重试；已有缓存仍可查看。</Notice>}
    {expanded && <>{authenticated ? <><p className="muted small github-account-note">登录方式：{status?.method === 'browser' || status?.method === 'gcm' ? '系统浏览器授权' : '个人访问令牌'}{status?.expiresAt ? ' · 到期 ' + new Date(status.expiresAt).toLocaleString('zh-CN') : ''}。退出只影响本管理器，不清除系统 Git 凭据。</p><button className="button small-button" disabled={!!pending} onClick={logout}><LogOut size={14}/>退出管理器账号</button></> : <div className="github-login-options">
      <form onSubmit={event => {event.preventDefault();void authenticate('browser');}}><h4><Github size={16}/>在 GitHub 官方页面登录</h4><p className="muted small">通过本机 Git Credential Manager 打开浏览器授权。Git 登录可能同步保存到系统凭据管理器。</p><label className="field-label">GitHub 用户名<input aria-label="GitHub 用户名" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="例如 octocat" disabled={!!pending}/></label><button className="button primary" disabled={loginDisabled || !username.trim() || !status?.browserAvailable}><ExternalLink size={14}/>打开浏览器登录</button>{status && !status.browserAvailable && <p className="muted small">当前环境未提供浏览器授权，请使用下方个人访问令牌。</p>}</form>
      <form onSubmit={event => {event.preventDefault();void authenticate('token');}} autoComplete="off"><h4><KeyRound size={16}/>使用个人访问令牌</h4><p className="muted small">只需公开仓库读取，无需 repo 写权限。请在 GitHub 官方页面创建令牌，再粘贴到这里。</p><label className="field-label">Personal access token<input type="password" aria-label="GitHub 个人访问令牌" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} placeholder="粘贴令牌，提交后立即清空" disabled={!!pending}/></label><div className="inline"><button className="button" disabled={loginDisabled || !token.trim()}><ShieldCheck size={14}/>验证并登录</button><button type="button" className="text-button" disabled={!!pending} onClick={() => {void call('github.openTokenPage').catch(value => setError(errorText(value)));}}>创建令牌<ExternalLink size={12}/></button></div><p className="muted small">{status?.storageAvailable ? '凭据由桌面程序加密保存。' : '系统加密不可用，暂不能保存登录；请检查桌面环境。'} 页面不保留或显示令牌。</p></form>
    </div>}</>}
    {pending && <div className="github-login-pending" role="status"><Loader2 size={16} className="spin"/><span>{pending === 'browser' ? '请在浏览器完成授权（已等待 ' + Math.floor((now - started) / 1000) + ' 秒，最多 180 秒）' : pending === 'token' ? '正在验证 GitHub 账号…' : '正在退出…'}</span>{pending !== 'logout' && <button className="button small-button" onClick={cancel}>取消登录</button>}</div>}
    {!authenticated && status?.error != null && <Notice tone="warning">{errorText(status.error)}</Notice>}
    {loginCooldown > 0 && <Notice tone="warning">验证账号暂时受限，约 {loginCooldown} 秒后可再次登录。</Notice>}
    {error && <div role="alert"><Notice tone="error">{error}</Notice></div>}
    {notice && (!compact || expanded || !authenticated) && <p className="muted small" role="status">{notice}</p>}
  </section>;
}
