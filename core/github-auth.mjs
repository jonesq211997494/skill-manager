import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT = 64 * 1024;
const USERNAME = /^[a-z\d]+(?:-[a-z\d]+)*$/i;
const EXPIRED = 'GitHub 登录已失效，请重新登录。';

export class GitHubAuthError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'GitHubAuthError';
    this.code = code;
    if (details) this.details = details;
  }
}

function error(message, code, details) { return new GitHubAuthError(message, code, details); }
function validUsername(value) { return typeof value === 'string' && value.length <= 39 && USERNAME.test(value); }
function validToken(value) { return typeof value === 'string' && /^[a-z\d_.-]{8,1024}$/i.test(value); }

// 移除可能将凭据写入磁盘的继承调试变量。
function commandEnvironment(interactive) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GCM_TRACE|GIT_TRACE)/i.test(key)) delete env[key];
  }
  if (!interactive) env.GCM_INTERACTIVE = 'never';
  else delete env.GCM_INTERACTIVE;
  return env;
}

function runCommand(command, args, { input = '', timeout = 10_000, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let finished = false;
    let stdout = '';
    let outputBytes = 0;
    let timer;
    const stopChild = () => {
      if (!child || child.exitCode != null || child.signalCode != null) return;
      const killDirectly = () => {
        try { if (child.exitCode == null && child.signalCode == null) child.kill(); } catch { /* 清理失败不覆盖原始取消原因。 */ }
      };
      if (process.platform !== 'win32' || !Number.isSafeInteger(child.pid) || child.pid <= 0) return killDirectly();
      try {
        // 只终止本次启动且尚未结束的 Git 进程及其凭据助手子进程。
        const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore',
        });
        cleanup.once('error', killDirectly);
        cleanup.once('exit', code => { if (code !== 0) killDirectly(); });
        cleanup.unref();
      } catch { killDirectly(); }
    };
    const finish = (failure, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) {
        stopChild();
        reject(failure);
      } else resolve(result);
    };
    const abort = () => finish(error('GitHub 登录已取消。', 'AUTH_CANCELLED'));
    if (signal?.aborted) return abort();
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch {
      return finish(error('无法启动 Git Credential Manager。', 'AUTH_HELPER_FAILED'));
    }
    timer = setTimeout(() => finish(error('GitHub 登录超时，请重新尝试。', 'AUTH_TIMEOUT')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk, retain) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) return finish(error('GitHub 登录工具返回了异常结果。', 'AUTH_HELPER_FAILED'));
      if (retain) stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    child.on('error', () => finish(error('无法启动 Git Credential Manager。', 'AUTH_HELPER_FAILED')));
    child.on('close', code => code === 0
      ? finish(null, { stdout, code: 0 })
      : finish(error('GitHub 登录未完成，请重新尝试。', 'AUTH_HELPER_FAILED')));
    child.stdin.on('error', () => finish(error('GitHub 登录工具未能读取请求。', 'AUTH_HELPER_FAILED')));
    child.stdin.end(input);
  });
}

function userSummary(value) {
  if (!value || !validUsername(value.login) || !Number.isSafeInteger(value.id) || value.id <= 0) {
    throw error('GitHub 返回的账号信息无效。', 'AUTH_INVALID_RESPONSE');
  }
  const user = { id: value.id, login: value.login, name: typeof value.name === 'string' ? value.name.slice(0, 160) : null,
    htmlUrl: `https://github.com/${value.login}` };
  try {
    const avatar = new URL(value.avatar_url ?? value.avatarUrl);
    if (avatar.protocol === 'https:' && avatar.hostname === 'avatars.githubusercontent.com') user.avatarUrl = avatar.href;
  } catch { /* 头像为可选字段。 */ }
  return user;
}

/** 凭据仅留在主进程，渲染进程只能接收 status() 的脱敏结果。 */
export class GitHubAuth {
  #session = null;
  #active = null;
  #browserAvailable = false;
  #initialized = false;
  #cancelGeneration = 0;
  #lastError = null;
  #initializePromise;

  constructor({ dataDir, fetchImpl = globalThis.fetch, safeStorage, runCommand: command = runCommand, onChange = () => {}, now = () => Date.now(), getProxy = () => '' }) {
    this.credentialPath = path.join(dataDir, 'credentials', 'github.enc');
    this.fetchImpl = fetchImpl;
    this.safeStorage = safeStorage;
    this.runCommand = command;
    this.onChange = onChange;
    this.now = now;
    this.getProxy = getProxy;
  }

  #storageAvailable() {
    try { return Boolean(this.safeStorage?.isEncryptionAvailable()) && this.safeStorage?.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; }
  }

  #changed() {
    try { this.onChange(); } catch { /* 界面刷新失败不影响已经完成的凭据操作。 */ }
  }

  #browserEnvironment(interactive) {
    const env = commandEnvironment(interactive);
    let proxy;
    try {
      const configured = this.getProxy();
      if (!configured) return env;
      proxy = new URL(configured);
    } catch { throw error('代理配置无效，请检查设置后重新登录。', 'AUTH_PROXY_INVALID'); }
    if (!['http:', 'https:'].includes(proxy.protocol)) throw error('浏览器登录目前需要 HTTP 或 HTTPS 代理，请调整代理设置或使用 Token 登录。', 'AUTH_PROXY_UNSUPPORTED');
    env.HTTP_PROXY = proxy.href;
    env.HTTPS_PROXY = proxy.href;
    env.http_proxy = proxy.href;
    env.https_proxy = proxy.href;
    return env;
  }

  async initialize() {
    if (this.#initializePromise) return this.#initializePromise;
    this.#initializePromise = this.#initialize();
    return this.#initializePromise;
  }

  async #initialize() {
    // 启动只读取本应用的加密文件，不访问 Git 凭据库或 GitHub。
    if (existsSync(this.credentialPath)) {
      if (!this.#storageAvailable()) this.#lastError = '系统加密存储不可用，请恢复后重新登录。';
      else {
        try {
          if (statSync(this.credentialPath).size > MAX_OUTPUT) throw new Error('size');
          const saved = JSON.parse(this.safeStorage.decryptString(readFileSync(this.credentialPath)));
          if (saved.version !== 1 || !validToken(saved.token) || !['token', 'browser'].includes(saved.method)) throw new Error('format');
          if (saved.expiresAt != null && !Number.isFinite(saved.expiresAt)) throw new Error('expiry');
          this.#session = { token: saved.token, user: userSummary(saved.user), method: saved.method, expiresAt: saved.expiresAt ?? null };
        } catch {
          this.#lastError = '无法读取已保存的 GitHub 登录，请重新登录。';
        }
      }
    }
    try {
      const result = await this.runCommand('git', ['credential-manager', '--version'], {
        timeout: 5000, env: commandEnvironment(false),
      });
      this.#browserAvailable = result?.code == null || result.code === 0;
    } catch { this.#browserAvailable = false; }
    this.#initialized = true;
    return this.status();
  }

  #expire() {
    if (this.#session?.expiresAt && this.#session.expiresAt <= this.now()) {
      this.#session = null;
      this.#lastError = EXPIRED;
      try { rmSync(this.credentialPath, { force: true }); } catch { /* 即使删除失败，也不再返回已过期的凭据。 */ }
      this.#changed();
    }
  }

  status() {
    this.#expire();
    return {
      authenticated: Boolean(this.#session), user: this.#session ? { ...this.#session.user } : null,
      storageAvailable: this.#storageAvailable(), browserAvailable: this.#browserAvailable,
      method: this.#session?.method ?? null, expiresAt: this.#session?.expiresAt ?? null,
      ...(this.#lastError ? { error: this.#lastError } : {}),
    };
  }

  getCredential() {
    this.#expire();
    if (!this.#session) return null;
    return { token: this.#session.token,
      cacheKey: `${this.#session.user.id}:${createHash('sha256').update(this.#session.token).digest('hex').slice(0, 32)}` };
  }

  #begin() {
    if (this.#active) throw error('已有 GitHub 登录正在进行，请先完成或取消。', 'AUTH_BUSY');
    if (!this.#storageAvailable()) throw error('系统加密存储不可用，无法安全保存 GitHub 登录。', 'AUTH_STORAGE_UNAVAILABLE');
    const operation = { controller: new AbortController() };
    this.#active = operation;
    return operation;
  }

  #check(operation) {
    if (operation !== this.#active || operation.controller.signal.aborted) throw error('GitHub 登录已取消。', 'AUTH_CANCELLED');
  }

  async #verify(token, operation) {
    this.#check(operation);
    const signal = AbortSignal.any([operation.controller.signal, AbortSignal.timeout(20_000)]);
    let response;
    try {
      response = await this.fetchImpl('https://api.github.com/user', {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Skill-Manager' },
        redirect: 'error', signal,
      });
      this.#check(operation);
      if (response.status === 401) throw error('GitHub 凭据无效或已过期，请重新生成后尝试。', 'AUTH_UNAUTHORIZED');
      if (response.status === 429 || (response.status === 403 && (response.headers?.get('x-ratelimit-remaining') === '0' || response.headers?.get('retry-after')))) {
        const resetSeconds = Number(response.headers?.get('x-ratelimit-reset'));
        const retrySeconds = Number(response.headers?.get('retry-after'));
        const retryAt = Number.isFinite(retrySeconds) && retrySeconds > 0 ? this.now() + retrySeconds * 1000
          : Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : this.now() + 60_000;
        throw error('GitHub 暂时限制了登录验证请求，请稍后重试。', 'AUTH_RATE_LIMITED', { retryAt: new Date(retryAt).toISOString(), reset: new Date(retryAt).toISOString(), retryAfter: Math.max(0, Math.ceil((retryAt - this.now()) / 1000)), resource: 'core' });
      }
      if (response.status === 403) throw error('GitHub 拒绝验证此凭据，请检查令牌权限或账号限制。', 'AUTH_FORBIDDEN');
      if (!response.ok) throw error('GitHub 登录验证暂时不可用，请稍后重试。', 'AUTH_REQUEST_FAILED');
      const declaredSize = Number(response.headers?.get('content-length'));
      if (declaredSize > MAX_OUTPUT) throw error('GitHub 返回的账号信息过大。', 'AUTH_INVALID_RESPONSE');
      let body;
      try {
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          const chunks = [];
          let totalBytes = 0;
          try {
            for (;;) {
              this.#check(operation);
              const { done, value } = await reader.read();
              if (done) break;
              totalBytes += value.byteLength;
              if (totalBytes > MAX_OUTPUT) {
                void reader.cancel().catch(() => {});
                throw error('GitHub 返回的账号信息过大。', 'AUTH_INVALID_RESPONSE');
              }
              chunks.push(Buffer.from(value));
            }
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } finally { reader.releaseLock(); }
        } else {
          body = await response.json();
          if (Buffer.byteLength(JSON.stringify(body)) > MAX_OUTPUT) throw error('GitHub 返回的账号信息过大。', 'AUTH_INVALID_RESPONSE');
        }
      } catch (failure) {
        if (failure instanceof GitHubAuthError) throw failure;
        throw error('GitHub 返回的账号信息无效。', 'AUTH_INVALID_RESPONSE');
      }
      this.#check(operation);
      const expiresHeader = response.headers?.get('github-authentication-token-expiration');
      const expiry = expiresHeader ? Date.parse(expiresHeader) : NaN;
      if (Number.isFinite(expiry) && expiry <= this.now()) throw error(EXPIRED, 'AUTH_UNAUTHORIZED');
      return { user: userSummary(body), expiresAt: Number.isFinite(expiry) ? expiry : null };
    } catch (failure) {
      this.#check(operation);
      if (failure instanceof GitHubAuthError) throw failure;
      throw error(signal.aborted ? 'GitHub 登录验证超时，请重新尝试。' : '无法连接 GitHub 完成登录验证，请检查网络后重试。', signal.aborted ? 'AUTH_TIMEOUT' : 'AUTH_NETWORK');
    }
  }

  #save(session, operation) {
    this.#check(operation);
    if (!this.#storageAvailable()) throw error('系统加密存储不可用，无法安全保存 GitHub 登录。', 'AUTH_STORAGE_UNAVAILABLE');
    const temporary = `${this.credentialPath}.${randomUUID()}.tmp`;
    try {
      const encrypted = this.safeStorage.encryptString(JSON.stringify({ version: 1, ...session }));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('encryption');
      mkdirSync(path.dirname(this.credentialPath), { recursive: true });
      writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      // 同步提交，避免取消或退出操作与文件写入交错。
      this.#check(operation);
      renameSync(temporary, this.credentialPath);
    } catch (failure) {
      try { rmSync(temporary, { force: true }); } catch { /* 临时文件中同样只有密文。 */ }
      if (failure instanceof GitHubAuthError) throw failure;
      throw error('无法安全保存 GitHub 登录，请检查数据目录权限后重试。', 'AUTH_STORAGE_FAILED');
    }
    this.#session = session;
    this.#lastError = null;
    this.#changed();
    return this.status();
  }

  async loginToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!validToken(token)) throw error('请输入有效的 GitHub Personal Access Token。', 'AUTH_INVALID_TOKEN');
    const operation = this.#begin();
    try {
      const verified = await this.#verify(token, operation);
      return this.#save({ token, ...verified, method: 'token' }, operation);
    } finally {
      if (this.#active === operation) this.#active = null;
    }
  }

  async loginBrowser({ username } = {}) {
    const login = typeof username === 'string' ? username.trim() : '';
    if (!validUsername(login)) throw error('请输入有效的 GitHub 用户名（不要填写邮箱）。', 'AUTH_INVALID_USERNAME');
    const generation = this.#cancelGeneration;
    if (!this.#initialized) await this.initialize();
    if (generation !== this.#cancelGeneration) throw error('GitHub 登录已取消。', 'AUTH_CANCELLED');
    if (!this.#browserAvailable) throw error('未检测到 Git Credential Manager，请安装新版 Git for Windows 或使用 Token 登录。', 'AUTH_BROWSER_UNAVAILABLE');
    const operation = this.#begin();
    try {
      const result = await this.runCommand('git', ['credential-manager', 'github', 'login', '--url', 'https://github.com', '--username', login, '--force', '--browser'], {
        timeout: 180_000, signal: operation.controller.signal, env: this.#browserEnvironment(true),
      });
      this.#check(operation);
      if (result?.code != null && result.code !== 0) throw error('GitHub 浏览器登录未完成，请重新尝试。', 'AUTH_HELPER_FAILED');
      const stored = await this.runCommand('git', ['credential-manager', 'get', '--no-ui'], {
        input: `protocol=https\nhost=github.com\nusername=${login}\n\n`, timeout: 15_000,
        signal: operation.controller.signal, env: this.#browserEnvironment(false),
      });
      this.#check(operation);
      if (stored?.code != null && stored.code !== 0) throw error('未能读取本次登录的 GitHub 凭据。', 'AUTH_HELPER_FAILED');
      if (typeof stored?.stdout !== 'string' || Buffer.byteLength(stored.stdout) > MAX_OUTPUT) throw error('GitHub 登录工具返回了异常结果。', 'AUTH_HELPER_FAILED');
      const values = new Map(stored.stdout.split(/\r?\n/).filter(Boolean).map(line => {
        const equals = line.indexOf('=');
        return [line.slice(0, equals), line.slice(equals + 1)];
      }));
      if ((values.has('protocol') && values.get('protocol') !== 'https') || (values.has('host') && values.get('host') !== 'github.com') || !validToken(values.get('password'))) {
        throw error('未能读取本次登录的 GitHub 凭据。', 'AUTH_HELPER_FAILED');
      }
      const token = values.get('password');
      const verified = await this.#verify(token, operation);
      if (verified.user.login.toLowerCase() !== login.toLowerCase()) throw error('浏览器登录的 GitHub 账号与填写的用户名不同，请重新登录。', 'AUTH_ACCOUNT_MISMATCH');
      const helperExpiry = Number(values.get('password_expiry_utc'));
      if (Number.isFinite(helperExpiry) && helperExpiry > 0) verified.expiresAt = verified.expiresAt == null ? helperExpiry * 1000 : Math.min(verified.expiresAt, helperExpiry * 1000);
      if (verified.expiresAt != null && verified.expiresAt <= this.now()) throw error(EXPIRED, 'AUTH_UNAUTHORIZED');
      return this.#save({ token, ...verified, method: 'browser' }, operation);
    } catch (failure) {
      this.#check(operation);
      if (failure instanceof GitHubAuthError) throw failure;
      throw error('GitHub 浏览器登录未完成，请重新尝试。', 'AUTH_HELPER_FAILED');
    } finally {
      if (this.#active === operation) this.#active = null;
    }
  }

  cancelLogin() {
    this.#cancelGeneration++;
    this.#active?.controller.abort();
  }

  logout() {
    this.cancelLogin();
    this.#session = null;
    this.#lastError = null;
    try { rmSync(this.credentialPath, { force: true }); }
    catch {
      this.#lastError = '当前会话已退出，但无法删除本机加密凭据文件，请检查数据目录权限后再次退出。';
      this.#changed();
      throw error(this.#lastError, 'AUTH_STORAGE_FAILED');
    }
    this.#changed();
    return this.status();
  }

  invalidate(_reason) {
    this.logout();
    this.#lastError = EXPIRED;
    return this.status();
  }
}
