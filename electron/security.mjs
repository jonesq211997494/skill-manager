// 生产渲染器不直接联网；在线请求统一经过受校验的主进程服务。
export function rendererCsp(development = false) {
  return [
    "default-src 'none'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ''}`,
    // React 动态字号、进度和布局仍使用 style 属性，例外仅限样式。
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'",
    `connect-src ${development ? "'self' ws://127.0.0.1:5173" : "'none'"}`,
    "object-src 'none'", "frame-src 'none'", "worker-src 'none'",
    "base-uri 'none'", "form-action 'none'",
  ].join('; ') + ';';
}
export function isTrustedRendererUrl(value, entry) {
  try {
    const candidate = new URL(value), allowed = new URL(entry);
    return !candidate.username && !candidate.password
      && candidate.protocol === allowed.protocol && candidate.host === allowed.host
      && candidate.pathname === allowed.pathname && candidate.search === allowed.search;
  } catch { return false; }
}
