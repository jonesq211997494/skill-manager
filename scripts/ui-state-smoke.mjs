import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// 使用模拟 IPC 检查异步详情与索引刷新，不访问真实技能目录。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const server = http.createServer(async (request, response) => {
  try {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep)) {response.writeHead(403); response.end(); return;}
    response.setHeader('Content-Type', ({'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml'})[path.extname(file)] || 'application/octet-stream');
    response.end(await fs.readFile(file));
  } catch {response.writeHead(404); response.end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const report={status:'running',checkedAt:new Date().toISOString(),steps:[]};
try {
  const channel = process.env.SKILL_MANAGER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({channel, headless:true});
  const page = await browser.newPage({viewport:{width:1366, height:900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const github = {authenticated:false, user:null, storageAvailable:false, browserAvailable:false};
    const skill = {id:'state-fixture', name:'状态测试技能', physicalPath:'D:/fixture/skill', description:'扫描前描述', body:'扫描前正文', raw:'扫描前正文', health:'normal', management:'external', tools:[], aliases:[], tags:[]};
    let skills = [skill];
    let pending;
    window.stateFixture = {scanMode:'update', detailCalls:0, resolveDetail:() => pending?.resolve(), rejectDetail:() => pending?.reject()};
    const state = () => ({skills, roots:[], settings:{theme:'light', fontSize:14}, operations:[], adapters:[], updates:[], sources:[], recovery:[], github});
    window.manager = {
      onProgress:() => () => {},
      call:async method => {
        if (method === 'github.status') return github;
        if (method === 'bootstrap') return state();
        if (method === 'skills.detail') {
          window.stateFixture.detailCalls++;
          const captured = structuredClone(skills[0]);
          return new Promise((resolve, reject) => {pending = {resolve:() => resolve(captured), reject:() => reject(new Error('已关闭详情的过期错误'))};});
        }
        if (method === 'scan') {
          skills = window.stateFixture.scanMode === 'remove' ? [] : [{...skill, description:'扫描后描述', body:'扫描后正文', raw:'扫描后正文'}];
          return state();
        }
        throw new Error('未预期的测试调用：' + method);
      },
    };
  });
  const failures = [];
  const test = async (name, task) => {
    try {await task(); report.steps.push({name,status:'passed'}); console.log('通过：' + name);}
    catch (error) {failures.push({name, error:error.message}); report.steps.push({name,status:'failed',error:error.message}); console.error('失败：' + name + '\n' + error.message);}
  };
  const open = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.skill-main').click();
    await page.getByText('正在读取完整技能包…', {exact:true}).waitFor();
  };
  // 等待响应产生的微任务和 React 绘制，避免仅验证请求完成前的状态。
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await test('Escape 关闭后，迟到的详情不能重新打开面板', async () => {
    await open();
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.stateFixture.resolveDetail());
    await settle();
    assert.equal(await page.locator('.detail-panel.is-open').count(), 0);
  });
  await test('关闭详情后，迟到的错误不覆盖当前界面', async () => {
    await open();
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.stateFixture.rejectDetail());
    await settle();
    assert.equal(await page.getByRole('alert').count(), 0);
  });
  await test('重新扫描刷新已打开详情，并忽略扫描前的迟到响应', async () => {
    await open();
    await page.getByRole('button', {name:'重新扫描目录', exact:true}).click();
    await page.getByText('扫描完成，共识别 1 个技能包', {exact:true}).waitFor();
    await page.evaluate(() => window.stateFixture.resolveDetail());
    await settle();
    assert.equal(await page.locator('.detail-description').textContent(), '扫描后描述');
    assert.equal(await page.locator('.detail-panel .markdown').textContent(), '扫描后正文');
    assert.equal(await page.getByText('正在读取完整技能包…', {exact:true}).count(), 0);
  });
  await test('扫描移除技能时同步清理详情与批量选择', async () => {
    await open();
    await page.getByRole('checkbox', {name:'选择 状态测试技能', exact:true}).check();
    await page.evaluate(() => {window.stateFixture.scanMode = 'remove';});
    await page.getByRole('button', {name:'重新扫描目录', exact:true}).click();
    await page.getByText('扫描完成，共识别 0 个技能包', {exact:true}).waitFor();
    await page.evaluate(() => window.stateFixture.resolveDetail());
    await settle();
    assert.equal(await page.locator('.detail-panel.is-open').count(), 0);
    assert.equal(await page.getByRole('button', {name:'批量安装', exact:true}).count(), 0);
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  report.status='passed';
  console.log('界面状态回归通过：关闭详情、过期错误、扫描刷新、移除后的选择清理。');
} catch(error) {
  report.status='failed';report.error=error.message;
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await fs.mkdir(path.join(root,'test-results'),{recursive:true});
  await fs.writeFile(path.join(root,'test-results','ui-state-smoke.json'),JSON.stringify(report,null,2));
}
