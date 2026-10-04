import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=path.join(root,'.runtime',`github-ui-${Date.now()}`);
const home=path.join(runtime,'home');
await fs.mkdir(home,{recursive:true});
await fs.mkdir(path.join(root,'test-results'),{recursive:true});
const env={...process.env,SKILL_MANAGER_TEST:'1',SKILL_MANAGER_DATA_DIR:path.join(runtime,'data'),SKILL_MANAGER_HOME:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')};
delete env.ELECTRON_RUN_AS_NODE;
// 测试专用假凭据只进入本次隔离进程；网络在主进程完全替换，不读取真实账号。
const token='github_pat_TEST_ONLY_'+ 'x'.repeat(60);
let app;
const steps=[];const errors=[];
async function launch() {
  app=await electron.launch({args:[path.join(root,'electron','main.mjs')],env,timeout:60000});
  await app.evaluate(({net},expected)=>{
    globalThis.__githubMock={requests:[],searchCount:0};
    Object.defineProperty(net,'fetch',{configurable:true,value:async(url,options={})=>{
      const route=new URL(url).pathname;
      const authenticated=new Headers(options.headers).get('authorization')===`Bearer ${expected}`;
      const state=globalThis.__githubMock;
      state.requests.push({route,authenticated});
      if(!authenticated)throw new Error('测试禁止匿名请求或使用真实账号');
      if(route==='/user')return new Response(JSON.stringify({id:54321,login:'test-account',name:'隔离测试账号',html_url:'https://github.com/test-account'}),{status:200});
      if(route==='/search/repositories') {
        state.searchCount++;
        if(state.searchCount===1)return new Response(JSON.stringify({message:'API rate limit exceeded'}),{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-limit':'30','x-ratelimit-resource':'search','x-ratelimit-reset':String(Math.ceil(Date.now()/1000)+4),'retry-after':'3'}});
        return new Response(JSON.stringify({items:[{id:1,name:'cache-test',full_name:'test/cache-test',html_url:'https://github.com/test/cache-test',description:'请求次数测试',owner:{login:'test'},stargazers_count:1}],total_count:1}),{status:200,headers:{'x-ratelimit-remaining':'29','x-ratelimit-limit':'30','x-ratelimit-resource':'search','x-ratelimit-reset':String(Math.ceil(Date.now()/1000)+60)}});
      }
      throw new Error(`未配置的测试请求：${route}`);
    }});
  },token);
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('heading',{name:'我的技能',exact:true}).waitFor();
  return page;
}
try {
  let page=await launch();
  await page.getByRole('button',{name:'在线发现',exact:true}).click();
  const search=page.locator('form.online-search button[type="submit"], form.online-search button').last();
  assert.equal(await search.isDisabled(),true);
  await page.getByRole('button',{name:'登录 GitHub',exact:true}).click();
  const input=page.getByLabel('GitHub 个人访问令牌',{exact:true});
  assert.equal(await input.getAttribute('type'),'password');
  await input.fill(token);
  await page.getByRole('button',{name:'验证并登录',exact:true}).click();
  await page.getByText('@test-account',{exact:false}).first().waitFor();
  assert.equal((await page.locator('body').innerText()).includes(token),false);
  assert.equal(await search.isDisabled(),false);
  steps.push('未登录禁用在线入口；通过界面提交测试凭据后显示账号');
  const encrypted=await fs.readFile(path.join(runtime,'data','credentials','github.enc'));
  assert.equal(encrypted.includes(Buffer.from(token)),false);
  const database=await fs.readFile(path.join(runtime,'data','index.sqlite'));
  assert.equal(database.includes(Buffer.from(token)),false);
  steps.push('真实 Electron safeStorage 写出加密凭据，界面和 SQLite 不含明文');
  await page.getByLabel('在线搜索',{exact:true}).fill('cache-check');
  await search.click();
  await page.locator('.error-banner').waitFor();
  const banner=await page.locator('.error-banner').innerText();
  assert.match(banner,/预计可重试时间/);
  const retry=page.locator('.error-banner button').filter({hasText:/重试|等待|秒/}).first();
  assert.equal(await retry.isDisabled(),true);
  const callsBefore=await app.evaluate(()=>globalThis.__githubMock.searchCount);
  const blocked=await page.evaluate(async()=>{
    try{const r=await window.manager.call('sources.search',{query:'cache-check'});return r?.ok===false?r.error.code:null;}catch(e){return e.code;}
  });
  assert.equal(blocked,'RATE_LIMITED');
  assert.equal(await app.evaluate(()=>globalThis.__githubMock.searchCount),callsBefore);
  steps.push('限流显示恢复时间，冷却中禁重试且后端不发重复请求');
  await page.waitForFunction(()=>[...document.querySelectorAll('.error-banner button')].some(b=>b.textContent.includes('重试')&&!b.disabled),{},{timeout:10000});
  await page.locator('.error-banner').getByRole('button',{name:'重试原操作',exact:true}).click();
  await page.getByRole('heading',{name:'cache-test',exact:true}).waitFor();
  assert.equal(await app.evaluate(()=>globalThis.__githubMock.searchCount),2);
  steps.push('恢复后点击重试确实重新执行原搜索并显示结果');
  await search.click();
  await page.getByText('来自缓存',{exact:true}).first().waitFor();
  assert.equal(await app.evaluate(()=>globalThis.__githubMock.searchCount),2);
  await page.screenshot({path:path.join(root,'test-results','github-account-cache.png'),fullPage:true});
  steps.push('再次搜索命中缓存，远端请求计数保持不变');
  await app.close();app=null;
  page=await launch();
  const status=await page.evaluate(()=>window.manager.call('github.status'));
  assert.equal(status.authenticated,true);assert.equal(status.user.login,'test-account');
  assert.equal((await app.evaluate(()=>globalThis.__githubMock.requests)).length,0);
  steps.push('重启从本机加密存储恢复账号，不请求 GitHub、不读取其他 Git 凭据');
  await page.getByRole('button',{name:'在线发现',exact:true}).click();
  await page.getByRole('button',{name:'管理账号',exact:true}).click();
  await page.getByRole('button',{name:'退出管理器账号',exact:true}).click();
  await page.getByRole('button',{name:'验证并登录',exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.manager.call('github.status'))).authenticated,false);
  assert.equal(await fs.access(path.join(runtime,'data','credentials','github.enc')).then(()=>true,()=>false),false);
  const result=await page.evaluate(async()=>{try{const r=await window.manager.call('sources.search',{query:'cache-check'});return r?.ok===false?r.error.code:null;}catch(e){return e.code;}});
  assert.equal(result,'GITHUB_LOGIN_REQUIRED');
  assert.equal((await app.evaluate(()=>globalThis.__githubMock.requests)).length,0);
  steps.push('退出删除本程序凭据，在线接口不退回匿名访问');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'test-results','github-ui-smoke.json'),JSON.stringify({status:'passed',version:'0.1.1',checkedAt:new Date().toISOString(),steps,rendererErrors:errors,network:'全部为隔离进程中的模拟响应；未使用真实凭据'},null,2));
  console.log(`GitHub 登录、缓存与限流界面 ${steps.length} 项验证通过。`);
} catch(e) {
  if(app)try{await(await app.firstWindow()).screenshot({path:path.join(root,'test-results','github-ui-failure.png'),fullPage:true});}catch{}
  throw e;
} finally {await app?.close();}
