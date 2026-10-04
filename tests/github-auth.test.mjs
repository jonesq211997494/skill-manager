import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubAuth } from '../core/github-auth.mjs';

const TOKEN = 'TEST_ONLY_FAKE_FIXTURE_TOKEN_A_1234567890';
const TOKEN2 = 'TEST_ONLY_FAKE_FIXTURE_TOKEN_B_1234567890';
const USER = { id: 123, login: 'sample-user', name: 'Sample User', avatar_url: 'https://avatars.githubusercontent.com/u/123', email: 'not-returned@example.test' };

function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function response(status = 200, body = USER, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skill-manager-auth-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const safeStorage = encryption();
  const config = {
    dataDir, safeStorage,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(); },
    runCommand: async () => ({ code: 0, stdout: '2.7.3' }),
    ...overrides,
  };
  const auth = new GitHubAuth(config);
  return { auth, dataDir, calls, config, safeStorage };
}

test('PAT 验证后加密保存，渲染进程状态只含账号摘要', async t => {
  const { auth, dataDir, calls } = await fixture(t);
  const status = await auth.loginToken(` ${TOKEN} `);
  assert.equal(status.authenticated, true);
  assert.equal(status.user.login, USER.login);
  assert.equal(status.user.email, undefined);
  assert.equal(status.method, 'token');
  assert.equal(status.storageAvailable, true);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.redirect, 'error');
  const stored = await readFile(path.join(dataDir, 'credentials', 'github.enc'));
  assert.equal(stored.includes(Buffer.from(TOKEN)), false);
  assert.deepEqual(await readdir(path.join(dataDir, 'credentials')), ['github.enc']);
  const credential = auth.getCredential();
  assert.equal(credential.token, TOKEN);
  assert.match(credential.cacheKey, /^123:[a-f0-9]{32}$/);
  assert.equal(credential.cacheKey.includes(TOKEN), false);
  status.user.login = 'mutated';
  assert.equal(auth.status().user.login, USER.login);
});

test('初始化本地解密且只检测一次助手，不联网或读取共享账号', async t => {
  const { auth, config } = await fixture(t);
  await auth.loginToken(TOKEN);
  const commands = [];
  const reopened = new GitHubAuth({ ...config,
    fetchImpl: async () => assert.fail('startup must not call GitHub'),
    runCommand: async (...args) => { commands.push(args); return { code: 0 }; },
  });
  await Promise.all([reopened.initialize(), reopened.initialize()]);
  reopened.status();
  reopened.status();
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].slice(0, 2), ['git', ['credential-manager', '--version']]);
  assert.equal(reopened.status().authenticated, true);
  assert.equal(reopened.getCredential().cacheKey, auth.getCredential().cacheKey);
});

test('加密不可用时在网络请求和创建文件前拒绝登录', async t => {
  const { auth, calls, dataDir } = await fixture(t, { safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(auth.loginToken(TOKEN), { code: 'AUTH_STORAGE_UNAVAILABLE' });
  assert.equal(auth.status().storageAvailable, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(dataDir), []);
});

test('新登录遭遇 401、403、429 时保留原账号及加密凭据', async t => {
  const { auth, dataDir } = await fixture(t);
  await auth.loginToken(TOKEN);
  const initialFile = await readFile(path.join(dataDir, 'credentials', 'github.enc'));
  const initialCredential = auth.getCredential();
  for (const [status, expected, headers] of [
    [401, 'AUTH_UNAUTHORIZED', {}], [403, 'AUTH_FORBIDDEN', {}],
    [403, 'AUTH_RATE_LIMITED', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' }],
    [429, 'AUTH_RATE_LIMITED', { 'retry-after': '15' }],
  ]) {
    auth.fetchImpl = async () => response(status, { message: TOKEN2 }, headers);
    await assert.rejects(auth.loginToken(TOKEN2), failure => {
      assert.equal(failure.code, expected);
      assert.equal(failure.message.includes(TOKEN2), false);
      assert.equal(JSON.stringify(failure).includes(TOKEN2), false);
      if (expected === 'AUTH_RATE_LIMITED') assert.ok(Number.isFinite(Date.parse(failure.details.retryAt)));
      return true;
    });
    assert.deepEqual(auth.getCredential(), initialCredential);
    assert.deepEqual(await readFile(path.join(dataDir, 'credentials', 'github.enc')), initialFile);
  }
});

test('网络和加密失败不泄露令牌或覆盖原会话', async t => {
  const { auth } = await fixture(t);
  await auth.loginToken(TOKEN);
  auth.fetchImpl = async () => { throw new Error(`request headers Authorization: ${TOKEN2}`); };
  await assert.rejects(auth.loginToken(TOKEN2), failure => failure.code === 'AUTH_NETWORK' && !failure.message.includes(TOKEN2));
  assert.equal(auth.getCredential().token, TOKEN);
  auth.fetchImpl = async () => response();
  auth.safeStorage.encryptString = () => { throw new Error(TOKEN2); };
  await assert.rejects(auth.loginToken(TOKEN2), failure => failure.code === 'AUTH_STORAGE_FAILED' && !failure.message.includes(TOKEN2));
  assert.equal(auth.getCredential().token, TOKEN);
});

test('浏览器登录使用固定命令且只读取用户明确输入的账号', async t => {
  const commands = [];
  const { auth } = await fixture(t, { runCommand: async (...args) => {
    commands.push(args);
    return { code: 0, stdout: args[1].includes('get') ? `protocol=https\nhost=github.com\nusername=sample-user\npassword=${TOKEN}\n\n` : '' };
  } });
  await auth.initialize();
  assert.equal(commands.length, 1);
  const status = await auth.loginBrowser({ username: 'Sample-User' });
  assert.equal(status.method, 'browser');
  assert.equal(status.user.login, 'sample-user');
  assert.deepEqual(commands[1][1], ['credential-manager', 'github', 'login', '--url', 'https://github.com', '--username', 'Sample-User', '--force', '--browser']);
  assert.equal(commands[1][2].timeout, 180_000);
  assert.deepEqual(commands[2][1], ['credential-manager', 'get', '--no-ui']);
  assert.equal(commands[2][2].input, 'protocol=https\nhost=github.com\nusername=Sample-User\n\n');
  assert.equal(commands[2][2].env.GCM_INTERACTIVE, 'never');
  assert.equal(commands.some(item => item[1].some(argument => argument.includes(TOKEN))), false);
  const commandCount = commands.length;
  auth.logout();
  assert.equal(commands.length, commandCount, 'logout must not erase shared Git credentials');
});

test('浏览器返回其他账号时拒绝登录并保留原会话', async t => {
  const { auth } = await fixture(t, { runCommand: async (_command, args) => ({ code: 0, stdout: args.includes('get') ? `password=${TOKEN2}\n\n` : '' }) });
  await auth.loginToken(TOKEN);
  auth.fetchImpl = async () => response(200, { ...USER, id: 999, login: 'another-user' });
  await assert.rejects(auth.loginBrowser({ username: USER.login }), { code: 'AUTH_ACCOUNT_MISMATCH' });
  assert.equal(auth.getCredential().token, TOKEN);
});

test('浏览器助手错误不包含命令输出、令牌或标准错误内容', async t => {
  const { auth } = await fixture(t, { runCommand: async (_command, args) => {
    if (args.includes('--version')) return { code: 0 };
    throw new Error(`stderr password=${TOKEN}`);
  } });
  await assert.rejects(auth.loginBrowser({ username: USER.login }), failure => failure.code === 'AUTH_HELPER_FAILED' && !failure.message.includes(TOKEN));
  assert.equal(JSON.stringify(auth.status()).includes(TOKEN), false);
});

test('浏览器登录先校验用户名，并检测不可用的 GCM', async t => {
  let commands = 0;
  const { auth } = await fixture(t, { runCommand: async () => { commands++; throw new Error('unavailable'); } });
  for (const username of ['x\nhost=evil.test', '--username', 'foo@example.com', 'a--b', '']) {
    await assert.rejects(auth.loginBrowser({ username }), { code: 'AUTH_INVALID_USERNAME' });
  }
  assert.equal(commands, 0);
  await assert.rejects(auth.loginBrowser({ username: USER.login }), { code: 'AUTH_BROWSER_UNAVAILABLE' });
  assert.equal(commands, 1);
});

test('退出会取消进行中的验证，迟到响应不能恢复登录', async t => {
  let finish;
  const { auth, dataDir } = await fixture(t, { fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const pending = auth.loginToken(TOKEN);
  await assert.rejects(auth.loginToken(TOKEN2), { code: 'AUTH_BUSY' });
  auth.logout();
  finish(response());
  await assert.rejects(pending, { code: 'AUTH_CANCELLED' });
  assert.equal(auth.getCredential(), null);
  assert.deepEqual(await readdir(dataDir), []);
});

test('取消保留原会话且阻止迟到的浏览器助手读取共享凭据', async t => {
  let finish;
  let loginStarted;
  const started = new Promise(resolve => { loginStarted = resolve; });
  const commands = [];
  const { auth } = await fixture(t, { runCommand: async (_command, args) => {
    commands.push(args);
    if (args.includes('--version')) return { code: 0 };
    loginStarted();
    return new Promise(resolve => { finish = resolve; });
  } });
  await auth.loginToken(TOKEN);
  const pending = auth.loginBrowser({ username: USER.login });
  await started;
  auth.cancelLogin();
  finish({ code: 0 });
  await assert.rejects(pending, { code: 'AUTH_CANCELLED' });
  assert.equal(commands.some(args => args.includes('get')), false);
  assert.equal(auth.getCredential().token, TOKEN);
});

test('不返回到期凭据，失效操作只删除本应用加密文件', async t => {
  let now = Date.parse('2026-10-03T01:00:00Z');
  const { auth, dataDir } = await fixture(t, {
    now: () => now,
    fetchImpl: async () => response(200, USER, { 'github-authentication-token-expiration': '2026-10-03 01:01:00 UTC' }),
  });
  await auth.loginToken(TOKEN);
  assert.equal(auth.status().expiresAt, now + 60_000);
  now += 61_000;
  assert.equal(auth.getCredential(), null);
  assert.match(auth.status().error, /GitHub/);
  assert.deepEqual(await readdir(path.join(dataDir, 'credentials')), []);
  auth.fetchImpl = async () => response();
  await auth.loginToken(TOKEN);
  const result = auth.invalidate(`untrusted ${TOKEN}`);
  assert.equal(result.authenticated, false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.deepEqual(await readdir(path.join(dataDir, 'credentials')), []);
});

test('同账号更换令牌后缓存身份随之变化', async t => {
  const { auth } = await fixture(t);
  await auth.loginToken(TOKEN);
  const oldKey = auth.getCredential().cacheKey;
  await auth.loginToken(TOKEN2);
  assert.notEqual(auth.getCredential().cacheKey, oldKey);
});

test('加密文件损坏时返回安全状态，不请求网络或泄露内容', async t => {
  const { auth, config, dataDir } = await fixture(t);
  await auth.loginToken(TOKEN);
  await writeFile(path.join(dataDir, 'credentials', 'github.enc'), TOKEN);
  const reopened = new GitHubAuth({ ...config, fetchImpl: async () => assert.fail('must not fetch') });
  const status = await reopened.initialize();
  assert.equal(status.authenticated, false);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
});

test('浏览器助手继承应用 HTTP 代理并移除凭据追踪变量', async t => {
  const previous = process.env.GCM_TRACE_SECRETS;
  process.env.GCM_TRACE_SECRETS = 'true';
  t.after(() => previous == null ? delete process.env.GCM_TRACE_SECRETS : process.env.GCM_TRACE_SECRETS = previous);
  const commands = [];
  const { auth } = await fixture(t, {
    getProxy: () => 'http://127.0.0.1:7890',
    runCommand: async (_command, args, options) => {
      commands.push({ args, options });
      return { code: 0, stdout: args.includes('get') ? `password=${TOKEN}\n\n` : '' };
    },
  });
  await auth.loginBrowser({ username: USER.login });
  for (const { args, options } of commands) {
    assert.equal(options.env.GCM_TRACE_SECRETS, undefined);
    if (!args.includes('--version')) assert.equal(options.env.HTTPS_PROXY, 'http://127.0.0.1:7890/');
  }
});

test('不支持的浏览器代理在启动登录前报错且不影响 PAT 验证', async t => {
  const commands = [];
  const { auth } = await fixture(t, { getProxy: () => 'socks5://127.0.0.1:7890', runCommand: async (_command, args) => { commands.push(args); return { code: 0 }; } });
  await assert.rejects(auth.loginBrowser({ username: USER.login }), { code: 'AUTH_PROXY_UNSUPPORTED' });
  assert.equal(commands.length, 1);
  await auth.loginToken(TOKEN);
  assert.equal(auth.status().authenticated, true);
});


test('即使 Electron 报告支持加密，也拒绝明文回退存储', async t => {
  const { auth, calls } = await fixture(t, { safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' } });
  await assert.rejects(auth.loginToken(TOKEN), { code: 'AUTH_STORAGE_UNAVAILABLE' });
  assert.equal(auth.status().storageAvailable, false);
  assert.equal(calls.length, 0);
});

test('拒绝超大账号响应且不保存任何凭据', async t => {
  for (const headers of [{}, { 'content-length': '70000' }]) {
    const { auth, dataDir } = await fixture(t, { fetchImpl: async () => response(200, { ...USER, unused: 'x'.repeat(70_000) }, headers) });
    await assert.rejects(auth.loginToken(TOKEN), { code: 'AUTH_INVALID_RESPONSE' });
    assert.equal(auth.getCredential(), null);
    assert.deepEqual(await readdir(dataDir), []);
  }
});

test('退出时报告加密文件删除失败，同时清空内存账号', async t => {
  let changes = 0;
  const { auth, dataDir } = await fixture(t, { onChange: () => { changes++; } });
  await auth.loginToken(TOKEN);
  const credentialPath = path.join(dataDir, 'credentials', 'github.enc');
  await rm(credentialPath);
  await mkdir(credentialPath);
  assert.throws(() => auth.logout(), { code: 'AUTH_STORAGE_FAILED' });
  assert.equal(auth.status().authenticated, false);
  assert.equal(auth.getCredential(), null);
  assert.equal(changes, 2);
});

test('首次能力检测期间退出会阻止后续浏览器授权启动', async t => {
  let finishProbe;
  const commands = [];
  const { auth } = await fixture(t, { runCommand: async (_command, args) => {
    commands.push(args);
    return new Promise(resolve => { finishProbe = resolve; });
  } });
  const pending = auth.loginBrowser({ username: USER.login });
  auth.logout();
  finishProbe({ code: 0 });
  await assert.rejects(pending, { code: 'AUTH_CANCELLED' });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], ['credential-manager', '--version']);
});
