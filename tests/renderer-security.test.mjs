import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedRendererUrl, rendererCsp } from '../electron/security.mjs';

test('渲染入口校验精确匹配来源与路径，不接受前缀伪装', () => {
  const entry = 'file:///C:/Skill%20Manager/dist/index.html';
  assert.equal(isTrustedRendererUrl(entry, entry), true);
  assert.equal(isTrustedRendererUrl(`${entry}#history`, entry), true);
  for (const value of [`${entry}.evil`, `${entry}/other`, `${entry}?next=evil`, 'file://remote/C:/Skill%20Manager/dist/index.html', 'https://example.com/']) {
    assert.equal(isTrustedRendererUrl(value, entry), false, value);
  }
  const dev = 'http://127.0.0.1:5173/';
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173', dev), true);
  for (const value of ['http://127.0.0.1:51730/', 'http://127.0.0.1:5173/other', 'http://user@127.0.0.1:5173/', 'http://localhost:5173/']) {
    assert.equal(isTrustedRendererUrl(value, dev), false, value);
  }
});

test('生产 CSP 禁止远端连接、脚本例外及嵌入资源', () => {
  const policy = rendererCsp(false);
  assert.match(policy, /script-src 'self';/);
  assert.match(policy, /connect-src 'none';/);
  assert.match(policy, /object-src 'none';/);
  assert.match(policy, /form-action 'none';/);
  assert.match(policy, /frame-src 'none';/);
  assert.doesNotMatch(policy, /unsafe-eval|https:|http:|ws:/);
  const dev = rendererCsp(true);
  assert.match(dev, /ws:\/\/127\.0\.0\.1:5173/);
  assert.doesNotMatch(dev, /unsafe-eval/);
});
