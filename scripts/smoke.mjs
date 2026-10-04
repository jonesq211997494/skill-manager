import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=path.join(root,'.runtime','desktop-smoke');
const home=path.join(runtime,'home');
const fixture=path.join(home,'.agents','skills','research-notes');
await fs.mkdir(fixture,{recursive:true});
await fs.mkdir(path.join(root,'test-results'),{recursive:true});
await fs.writeFile(path.join(fixture,'SKILL.md'),'---\nname: research-notes\ndescription: 整理论文阅读笔记与研究记录\n---\n# 文献笔记\n\n保留出处，整理研究问题、方法和发现。\n');
const launchEnv={...process.env};delete launchEnv.ELECTRON_RUN_AS_NODE;
const instance=await electron.launch({args:[path.join(root,'electron','main.mjs')],env:{...launchEnv,SKILL_MANAGER_TEST:'1',SKILL_MANAGER_DATA_DIR:path.join(runtime,'data'),SKILL_MANAGER_HOME:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')},timeout:60000});
const page=await instance.firstWindow();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.waitForSelector('body');
  await page.evaluate(()=>window.manager.call('scan'));
  await page.reload();
  await page.getByText('research-notes',{exact:true}).first().waitFor({timeout:30000});
  await page.getByText('research-notes',{exact:true}).first().click();
  await page.waitForTimeout(500);
  for(const [width,height] of [[1366,768],[1920,1080],[960,720]]) {
    await page.setViewportSize({width,height});
    await page.screenshot({path:path.join(root,'test-results',`desktop-${width}x${height}.png`),fullPage:true});
  }
  if(errors.length)throw new Error(errors.join('\n'));
  const data=await page.evaluate(()=>window.manager.call('bootstrap'));
  if(data.skills.length!==1)throw new Error(`期望隔离环境只有1个技能，实际${data.skills.length}`);
  await fs.writeFile(path.join(root,'test-results','desktop-smoke.json'),JSON.stringify({ok:true,skills:data.skills.length,rendererErrors:errors,checkedAt:new Date().toISOString()},null,2));
  console.log('桌面隔离冒烟通过。');
} finally {await instance.close();}
