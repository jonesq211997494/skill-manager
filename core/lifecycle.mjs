import { AppError } from './errors.mjs';

// 先登记完整调用，再执行分发；关闭必须等待调用尾部的数据库回写。
export class ServiceLifecycle {
  constructor({ cancel, drain, close, isIdle }) {
    this.cancel = cancel;
    this.drain = drain;
    this.dispose = close;
    this.isIdle = isIdle;
    this.pending = new Set();
    this.closing = false;
    this.closed = false;
    this.shutdownPromise = null;
  }

  run(task) {
    if (this.closing) return Promise.reject(new AppError('SERVICE_CLOSING', '应用正在关闭，无法接受新的操作。'));
    let resolve, reject;
    const pending = new Promise((done, failed) => { resolve = done; reject = failed; });
    this.pending.add(pending);
    pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    try { resolve(task()); } catch (error) { reject(error); }
    return pending;
  }

  shutdown() { return this.beginShutdown(false); }

  // 空闲测试夹具及旧调用方可以同步释放 SQLite；有任何在途工作时转为受控关闭。
  close() { return this.beginShutdown(true); }

  beginShutdown(synchronous) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    let resolve, reject;
    this.shutdownPromise = new Promise((done, failed) => { resolve = done; reject = failed; });
    let cancellation, cancellationError;
    try { cancellation = this.cancel(); } catch (error) { cancellationError = error; }
    const finish = () => {
      this.dispose();
      this.closed = true;
      if (cancellationError) throw cancellationError;
    };
    if (synchronous && !this.pending.size && this.isIdle() && !cancellation?.then) {
      try { finish(); resolve(); } catch (error) { reject(error); }
    } else {
      const settle = async () => {
        try { await cancellation; } catch (error) { cancellationError = error; }
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        await this.drain();
        finish();
      };
      settle().then(resolve, reject);
    }
    return this.shutdownPromise;
  }
}
