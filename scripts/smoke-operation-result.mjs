import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// 使用隔离浏览器和模拟 IPC；不会读取用户目录或执行真实文件变更。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist = path.join(root,'dist');
const server = http.createServer(async (request,response) => {
  try {
    const relative = decodeURIComponent(new URL(request.url,'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(dist,relative);
    if(!file.startsWith(dist + path.sep)) {response.writeHead(403);response.end();return;}
    response.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)] || 'application/octet-stream');
    response.end(await fs.readFile(file));
  } catch {response.writeHead(404);response.end();}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  const channel = process.env.SKILL_MANAGER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({channel,headless:true});
  const page = await browser.newPage({viewport:{width:1366,height:768}});
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.addInitScript(() => {
    const operation = {id:'result-ui-fixture',kind:'import',summary:'复制到集中库',status:'completed',createdAt:'2026-10-04T12:00:00.000Z',steps:[{id:'step-ui-fixture',action:'install',status:'completed',tool:'library',sourcePath:'D:/fixture/source',targetPath:'D:/fixture/library/result-test',bytes:128}]};
    const plan = {...operation,digest:'fixture-digest',blockers:[],warnings:[]};
    const github = {authenticated:false,user:null,storageAvailable:false,browserAvailable:false};
    window.resultFixture = {execute:0,refresh:0};
    const state = () => ({skills:[],roots:[],settings:{theme:'light',fontSize:14},operations:window.resultFixture.execute ? [operation] : [],adapters:[],updates:[],sources:[],recovery:[],github});
    window.manager = {
      onProgress:() => () => {},
      call:async (method) => {
        if(method === 'github.status') return github;
        if(method === 'bootstrap') {
          if(window.resultFixture.execute && !window.resultFixture.refresh) throw new Error('模拟界面数据读取失败');
          return state();
        }
        if(method === 'dialog.directory') return 'D:/fixture/source';
        if(method === 'operations.plan') return plan;
        if(method === 'operations.execute') {window.resultFixture.execute++;return {...operation,operation,indexRefresh:{status:'failed',pending:true,stage:'scan',error:{code:'SCAN_FAILED',message:'模拟索引扫描失败'}}};}
        if(method === 'operations.refresh') {window.resultFixture.refresh++;operation.status = 'restored';return {...operation,operation,indexRefresh:{status:'completed',pending:false}};}
        throw new Error('未预期的测试调用：' + method);
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'导入技能',exact:true}).click();
  await page.getByText('确认后复制整个技能包，来源文件保留原位。',{exact:false}).waitFor();
  await page.getByRole('button',{name:'生成变更预览',exact:true}).click();
  await page.getByText('确认后复制来源技能包到下列目标，来源文件保留原位；执行前再次核验文件。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'确认执行',exact:true}).click();
  await page.getByRole('button',{name:'仅刷新索引',exact:true}).waitFor();
  await page.getByText('文件操作已完成；索引刷新失败，可仅刷新索引。',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await page.getByText('操作未完成',{exact:true}).count(),0);
  await fs.mkdir(path.join(root,'test-results'),{recursive:true});
  await page.screenshot({path:path.join(root,'test-results','operation-result-refresh-failed.png'),fullPage:true});
  await page.getByRole('button',{name:'查看操作',exact:true}).click();
  await page.getByText('每一步，都有迹可循',{exact:true}).waitFor();
  await page.getByText('操作 result-ui-fixture',{exact:true}).last().waitFor();
  await page.getByRole('button',{name:'仅刷新索引',exact:true}).click();
  await page.getByText('文件操作已恢复；索引已刷新。',{exact:true}).first().waitFor();
  assert.equal(await page.locator('.notice.success').filter({hasText:'文件操作已恢复；索引已刷新。'}).count(),1);
  assert.equal(await page.getByText('文件操作未完成，请查看操作记录',{exact:false}).count(),0);
  assert.deepEqual(await page.evaluate(() => window.resultFixture),{execute:1,refresh:1});
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'test-results','operation-result-ui.json'),JSON.stringify({ok:true,executeCalls:1,refreshCalls:1,restoredStatusUsesSuccess:true,rendererErrors:errors,checkedAt:new Date().toISOString()},null,2));
  console.log('操作结果 UI 隔离冒烟通过：文件成功、索引失败、界面读取失败、仅刷新、操作历史。');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
