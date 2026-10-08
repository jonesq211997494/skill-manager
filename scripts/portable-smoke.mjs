import { chromium } from 'playwright';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const artifactName=`Skill-Manager-${pkg.version}-portable.exe`;
await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
await fs.mkdir(path.join(root,'test-results'),{recursive:true});
const runtime=await fs.mkdtemp(path.join(root,'.runtime','portable-smoke-'));
const home=path.join(runtime,'home');
await fs.mkdir(home,{recursive:true});
const server=net.createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await new Promise(resolve=>server.close(resolve));
const env={...process.env,SKILL_MANAGER_TEST:'1',SKILL_MANAGER_DATA_DIR:path.join(runtime,'data'),SKILL_MANAGER_HOME:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')};
delete env.ELECTRON_RUN_AS_NODE;delete env.SKILL_MANAGER_DEV_URL;
const child=spawn(path.join(root,'release',artifactName),[`--remote-debugging-port=${port}`],{env,windowsHide:true,stdio:'ignore'});
let launchError;
child.on('error',error=>{launchError=error;});
let browser;
try {
  const until=Date.now()+55000;let connected=false;
  while(Date.now()<until) {
    if(launchError)throw launchError;
    if(child.exitCode!==null)throw new Error(`便携程序提前退出：${child.exitCode}`);
    try {const response=await fetch(`http://127.0.0.1:${port}/json/version`);if(response.ok){connected=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!connected)throw new Error('便携程序未在测试期限内启动。');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context=browser.contexts()[0];
  let page=context.pages()[0];if(!page)page=await context.waitForEvent('page');
  await page.getByRole('heading',{name:'我的技能',exact:true}).waitFor();
  await page.getByText(`v${pkg.version}`,{exact:true}).waitFor();
  const data=await page.evaluate(()=>window.manager.call('bootstrap'));
  if(data.skills.length!==0)throw new Error('便携测试未使用隔离的空环境。');
  await fs.writeFile(path.join(root,'test-results','portable-smoke.json'),JSON.stringify({status:'passed',checkedAt:new Date().toISOString(),executable:artifactName,skills:data.skills.length},null,2));
  console.log('最终便携 EXE 解包、启动和服务连接通过。');
  await page.evaluate(()=>window.close()).catch(()=>{});
} finally {
  await browser?.close().catch(()=>{});
  if(child.exitCode===null) {const exited=new Promise(resolve=>child.once('exit',resolve));await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);}
  // 便携 EXE 是解包包装器；失败时只清理本次启动的进程树，避免遗留其 Electron 子进程。
  if(child.exitCode===null && child.pid) {
    if(process.platform==='win32')await promisify(execFile)('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
    else child.kill();
  }
}
