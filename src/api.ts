export type RunTask = <T = any>(message: string, task: () => Promise<T>, options?: {retryable?: boolean; cancellable?: boolean}) => Promise<T | undefined>;
export type Progress = { message: string; current?: number; total?: number; kind?: string; done?: boolean; cancelled?: boolean };

declare global {
  interface Window {
    manager?: {
      call: (method: string, args?: unknown) => Promise<any>;
      onProgress: (listener: (progress: Progress) => void) => (() => void);
    };
  }
}

export async function call<T = any>(method: string, args?: unknown): Promise<T> {
  if (!window.manager) throw new Error('桌面服务尚未连接。请通过“启动技能管理器”启动应用，再重试。');
  const result = await window.manager.call(method, args);
  if (result && result.ok === false) throw Object.assign(new Error(result.error?.message || result.message || '操作未完成，请重试。'), {code:result.error?.code, details:result.error?.details});
  return result as T;
}

export function timestamp(value: unknown): number {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) {
    const number = Number(value); return Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : 0;
  }
  if (typeof value !== 'string') return 0;
  return Date.parse(value) || 0;
}

export function errorRetryAt(error: unknown): number {
  const details = (error as any)?.details || {};
  const absolute = timestamp(details.retryAt || details.reset);
  if (absolute) return absolute;
  const seconds = Number(details.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : timestamp(details.retryAfter);
}

export function requiresGitHubLogin(error: unknown): boolean {
  return ['GITHUB_LOGIN_REQUIRED','GITHUB_SESSION_EXPIRED','AUTH_CHANGED','UNAUTHORIZED'].includes((error as any)?.code);
}

export function errorText(error: unknown): string {
  const value = error as any;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : value?.message || '操作未完成，请重试。';
  const clean = message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  if (requiresGitHubLogin(error)) return 'GitHub 需要登录或重新验证账号。请在设置中的“GitHub 账号”完成登录，再重新发起在线操作。' + (clean ? ' ' + clean : '');
  const retryAt = errorRetryAt(error);
  return retryAt ? clean + ' 预计可重试时间：' + new Date(retryAt).toLocaleString('zh-CN', {hour12:false}) + '。' : clean;
}

export function subscribeProgress(listener: (progress: Progress) => void): () => void {
  return window.manager?.onProgress(listener) || (() => {});
}
