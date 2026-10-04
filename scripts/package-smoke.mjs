import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=path.join(root,'release','win-unpacked','Skill Manager.exe');
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const runtime=path.join(root,'.runtime','package-smoke');
const home=path.join(runtime,'home');
const skill=path.join(home,'.agents','skills','package-check');
await fs.mkdir(skill,{recursive:true});
await fs.writeFile(path.join(skill,'SKILL.md'),'---\nname: package-check\ndescription: 验证桌面交付包\n---\n# 安装包测试\n');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const verified=[];
for(const relative of ['dist/index.html','shared/version-status.mjs','core/service.mjs','core/ipc-contracts.mjs','core/lifecycle.mjs','core/operation-result.mjs','core/allowed-path.mjs','core/db-version.mjs','shared/operation-result.mjs','electron/security.mjs','core/source-bindings.mjs','core/indexing.mjs','core/storage.mjs','core/operations.mjs','core/sources.mjs','core/github-auth.mjs','electron/preload.cjs','electron/main.mjs','assets/icon.png']) {
  if(hash(extractFile(path.join(root,'release','win-unpacked','resources','app.asar'),relative))!==hash(await fs.readFile(path.join(root,relative))))throw new Error(`交付包与源码不一致：${relative}`);
  verified.push(relative);
}
const env={...process.env,SKILL_MANAGER_TEST:'1',SKILL_MANAGER_DATA_DIR:path.join(runtime,'data'),SKILL_MANAGER_HOME:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')};
delete env.ELECTRON_RUN_AS_NODE;
const instance=await electron.launch({executablePath:exe,args:[],env,timeout:60000});
const errors=[];
try {
  const page=await instance.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('heading',{name:'我的技能',exact:true}).waitFor();
  const scan=await page.evaluate(()=>window.manager.call('scan'));
  if(scan.skills.length!==1)throw new Error('交付包的隔离扫描结果错误。');
  const csp=await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  if(!csp?.includes("script-src 'self';")||!csp.includes("connect-src 'none';"))throw new Error('交付包缺少生产 CSP。');
  const inlineBlocked=await page.evaluate(async()=>{
    const script=document.createElement('script');script.textContent='window.__packageInline=true';document.body.append(script);
    await new Promise(resolve=>setTimeout(resolve,100));script.remove();
    return !window.__packageInline;
  });
  if(!inlineBlocked)throw new Error('交付包 CSP 未阻止内联脚本。');
  const info=await instance.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion(),node:process.versions.node,electron:process.versions.electron}));
  if(!info.packaged||info.version!==pkg.version)throw new Error('交付包版本资源不正确。');
  if(errors.length)throw new Error(errors.join('\n'));
  await fs.writeFile(path.join(root,'test-results','package-smoke.json'),JSON.stringify({status:'passed',checkedAt:new Date().toISOString(),...info,csp,inlineBlocked,verified,skills:scan.skills.length,rendererErrors:errors},null,2));
  console.log('打包后的 Windows 程序启动与扫描通过，源码和包内容一致。');
} finally {await instance.close();}
