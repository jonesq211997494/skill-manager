import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagerService } from '../core/service.mjs';

async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'skill-manager-auth-service-'));
  const home=path.join(root,'home');await fs.mkdir(home);
  let credential=null;let fetches=0;const requests=[];
  const auth={
    status:async()=>({authenticated:!!credential,user:credential?{id:7,login:'test-account'}:null,storageAvailable:true,browserAvailable:false}),
    getCredential:()=>credential,
    loginToken:async token=>{if(token!=='fixture-token')throw new Error('无效测试凭据');credential={token,cacheKey:'test-account-v1'};},
    loginBrowser:async()=>{throw new Error('测试不启动真实账户授权');},
    logout:async()=>{credential=null;},
    invalidate:async()=>{credential=null;},
    cancelLogin:()=>{},
  };
  const manager=new ManagerService({dataDir:path.join(root,'data'),home,auth,fetchImpl:async(url,options)=>{
    fetches++;requests.push({url,authorized:new Headers(options.headers).get('authorization')==='Bearer fixture-token'});
    return new Response(JSON.stringify({items:[],total_count:0}),{status:200,headers:{'x-ratelimit-limit':'5000','x-ratelimit-remaining':'4999','x-ratelimit-resource':'search','x-ratelimit-reset':String(Math.ceil(Date.now()/1000)+120)}});
  }});
  await manager.initialize();
  t.after(async()=>{manager.close();await fs.rm(root,{recursive:true,force:true});});
  return {manager,root,requests,fetches:()=>fetches};
}

test('未登录时在线入口均不发匿名请求，本地扫描保持可用',async t=>{
  const f=await setup(t);
  for(const [method,args] of [['sources.search',{query:'skills'}],['sources.inspect',{url:'https://github.com/owner/repo'}],['sources.preview',{candidate:{}}]]) {
    await assert.rejects(f.manager.call(method,args),e=>e.code==='GITHUB_LOGIN_REQUIRED');
  }
  assert.deepEqual(await f.manager.call('updates.check'),[]);
  assert.equal(f.fetches(),0);
  const scan=await f.manager.call('scan');assert.ok(Array.isArray(scan.skills));
  assert.equal(scan.github.authenticated,false);
});

test('登录后附带认证，重复搜索复用缓存，退出后不使用旧缓存匿名访问',async t=>{
  const f=await setup(t);
  const status=await f.manager.call('github.loginToken',{token:'fixture-token'});
  assert.equal(status.authenticated,true);assert.equal(status.user.login,'test-account');
  assert.equal(JSON.stringify(status).includes('fixture-token'),false);
  const first=await f.manager.call('sources.search',{query:'skills'});
  const second=await f.manager.call('sources.search',{query:'skills'});
  assert.equal(f.fetches(),1);assert.equal(f.requests[0].authorized,true);
  assert.equal(second.fromCache,true);assert.equal(first.stale,false);
  for(let i=0;i<4;i++)await f.manager.call('github.status');
  assert.equal(f.fetches(),1,'读取登录与配额状态不调用远端接口');
  const bootstrap=await f.manager.call('bootstrap');assert.equal(JSON.stringify(bootstrap).includes('fixture-token'),false);
  await f.manager.call('github.logout');
  await assert.rejects(f.manager.call('sources.search',{query:'skills'}),e=>e.code==='GITHUB_LOGIN_REQUIRED');
  assert.equal(f.fetches(),1);
});

test('更新检查对同一仓库和分支只强制刷新一次',async t=>{
  const f=await setup(t);await f.manager.call('github.loginToken',{token:'fixture-token'});
  const repository={id:55,url:'https://github.com/test/skills',fullName:'test/skills'};
  for(let i=0;i<2;i++)f.manager.store.put('deployments',String(i),{id:String(i),targetPath:path.join(f.root,`missing-${i}`),source:{repositoryId:55,url:repository.url,ref:'main',subdir:`skill-${i}`}});
  for(let i=0;i<2;i++)f.manager.store.put('skills',`skill-${i}`,{id:`skill-${i}`,name:`skill-${i}`,physicalPath:path.join(f.root,`missing-${i}`),aliases:[],tools:[],tracked:true,health:'normal'});
  let checks=0;const options=[];
  f.manager.sources.inspect=async(_url,opt)=>{checks++;options.push(opt);return {repository,skills:[],stale:false,commit:'a'.repeat(40),ref:'main'};};
  const result=await f.manager.call('updates.check');
  assert.equal(result.length,2);assert.equal(checks,1);assert.equal(options[0].forceRefresh,true);
});
