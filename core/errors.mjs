export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'AppError'; this.code = code; this.details = details;
  }
}
export function fail(code, message, details) { throw new AppError(code, message, details); }
export function serializeError(e) {
  return {code: e.code || 'UNEXPECTED_ERROR', message: e.message || String(e), details: e.details || {}, retryable: ['SOURCE_UNAVAILABLE','RATE_LIMITED','PLAN_STALE'].includes(e.code)};
}
