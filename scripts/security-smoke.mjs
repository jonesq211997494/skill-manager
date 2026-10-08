import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=path.join(root,'.runtime','security-'+Date.now());
const home=path.join(runtime,'home'), fixture=path.join(home,'.agents','skills','security-fixture');
await fs.mkdir(fixture,{recursive:true});
await fs.mkdir(path.join(root,'test-results'),{recursive:true});
await fs.writeFile(path.join(fixture,'SKILL.md'),`---
name: security-fixture
description: 隔离渲染安全验证
---
# 正常说明

**中文粗体**与正常列表仍应显示。

- 正常项目

\`\`\`js
const safe = true;
\`\`\`

<script>window.__markdownExecuted = true</script>
<img src="https://example.invalid/raw.png" onerror="window.__markdownExecuted = true">

![外部图片](https://example.invalid/markdown.png)
[危险协议](javascript:alert(1))
`);
const env={...process.env,SKILL_MANAGER_TEST:'1',SKILL_MANAGER_HOME:home,SKILL_MANAGER_DATA_DIR:path.join(runtime,'data'),CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')};
delete env.ELECTRON_RUN_AS_NODE; delete env.SKILL_MANAGER_DEV_URL;
let instance, page;
const requests=[], errors=[];
const report={status:'running',checkedAt:new Date().toISOString(),steps:[]};
try {
  instance=await electron.launch({args:[path.join(root,'electron/main.mjs')],env,timeout:60000});
  page=await instance.firstWindow({timeout:60000});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://example.invalid/**',route=>{requests.push(route.request().url());return route.abort();});
  await page.getByRole('heading',{name:'我的技能',exact:true}).waitFor();
  const policy=await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.match(policy,/script-src 'self';/); assert.match(policy,/connect-src 'none';/);
  await page.evaluate(()=>window.manager.call('scan'));
  await page.reload();
  await page.getByText('security-fixture',{exact:true}).first().click();
  await page.locator('.markdown strong').getByText('中文粗体',{exact:true}).waitFor();
  assert.equal(await page.locator('.markdown script,.markdown img,.markdown iframe').count(),0);
  assert.equal(await page.locator('.markdown a').getAttribute('href'),null);
  assert.equal(await page.evaluate(()=>window.__markdownExecuted),undefined);
  report.steps.push({name:'正常 Markdown 与恶意 HTML、外部图片、危险协议隔离',status:'passed'});
  const blocked=await page.evaluate(async()=>{
    const violations=[];
    const listener=event=>violations.push(event.effectiveDirective);
    document.addEventListener('securitypolicyviolation',listener);
    const script=document.createElement('script');script.textContent='window.__inlineExecuted=true';document.body.append(script);
    const image=document.createElement('img');image.src='https://example.invalid/csp.png';document.body.append(image);
    let fetchBlocked=false;
    try {await fetch('https://example.invalid/csp.json');} catch {fetchBlocked=true;}
    await new Promise(resolve=>setTimeout(resolve,250));
    script.remove();image.remove();document.removeEventListener('securitypolicyviolation',listener);
    return {ran:!!window.__inlineExecuted,fetchBlocked,violations};
  });
  assert.equal(blocked.ran,false);assert.equal(blocked.fetchBlocked,true);
  assert.ok(blocked.violations.includes('script-src-elem'));
  assert.ok(blocked.violations.includes('img-src'));assert.ok(blocked.violations.includes('connect-src'));
  assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
  report.steps.push({name:'Chromium 实际阻止内联脚本及未经允许的网络请求',status:'passed'});
  const invalid=await page.evaluate(()=>window.manager.call('settings.save',{backupLimitGB:'2'}));
  assert.equal(invalid.ok,false);assert.equal(invalid.error.code,'INVALID_ARGUMENT');
  report.steps.push({name:'生产 IPC 返回稳定参数错误码',status:'passed'});
  await page.screenshot({path:path.join(root,'test-results','security-smoke.png')});
  await instance.close(); instance=null;
  report.steps.push({name:'Electron 正常退出等待服务收尾',status:'passed'});
  report.status='passed';
  console.log('生产渲染安全与受控退出冒烟通过。');
} catch(error) {
  report.status='failed';report.error=error.message;process.exitCode=1;
  if(instance) {
    try {
      report.windowState=await instance.evaluate(({app,BrowserWindow})=>({ready:app.isReady(),windows:BrowserWindow.getAllWindows().map(window=>({destroyed:window.isDestroyed(),url:window.webContents.getURL(),loading:window.webContents.isLoading()}))}));
      console.error('失败时的桌面窗口状态：',JSON.stringify(report.windowState));
    } catch { /* 主进程已退出时保留原始失败，不覆盖它。 */ }
  }
  console.error(error);
} finally {
  if(instance)await instance.close();
  report.rendererErrors=errors;report.unexpectedRequests=requests;
  await fs.writeFile(path.join(root,'test-results','security-smoke.json'),JSON.stringify(report,null,2));
}
