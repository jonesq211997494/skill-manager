import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { scanRoots, buildManifest, analyzeDuplicates, parseSkill } from './scanner.mjs';
import { discoverRoots, inspectAdapters, readConfigStates } from './adapters.mjs';
import { SourceService } from './sources.mjs';
import { OperationEngine, compareVersions, hashText, inside } from './operations.mjs';
import { previewMigration, importMigration } from './migration.mjs';
import { fail } from './errors.mjs';
import { readRevisionFile } from './diff.mjs';
import { SourceBindings, compareSourceContent } from './source-bindings.mjs';
import { reconcileScan, detachRoots } from './indexing.mjs';
import { inspectStorage } from './storage.mjs';
import { resolveAllowedOpenPath } from './allowed-path.mjs';
import { parseIpcArgs } from './ipc-contracts.mjs';
import { ServiceLifecycle } from './lifecycle.mjs';
import { executeWithRefresh, recordRegistrationRemoval } from './operation-result.mjs';
import { buildVersionStates, getSkillVersionStatus, versionStateMatches, hasVersionSource, getVersionTargets } from '../shared/version-status.mjs';

export class ManagerService {
  constructor({dataDir,home=os.homedir(),onProgress=()=>{},fetchImpl,auth=null,openPath,openExternal,chooseDirectory,chooseFile,onSettings=()=>{}}) {
    Object.assign(this,{dataDir,home,onProgress,openPath,openExternal,chooseDirectory,chooseFile,onSettings,auth});
    this.store=new Store(dataDir);
    this.sources=new SourceService({dataDir,fetchImpl,requireAuth:true,
      getCredential:()=>this.auth?.getCredential()||null,
      onUnauthorized:async cacheKey=>{
        const current=await this.auth?.getCredential();
        if(current?.cacheKey===cacheKey) {
          await this.auth.invalidate('GitHub 登录已失效，请重新登录。');
          this.sources.resetAuthState?.();
        }
      },
      onRateLimit:status=>this.progress({kind:'github',message:'GitHub 请求状态已更新',rateLimits:status})
    });
    this.jobs=new Map(); this.queryPromises=new Map();this.operationCount=0;this.protectedRoots=[];this.sequence=0;
    this.bindings=new SourceBindings({store:this.store,sources:{inspect:(...a)=>this.sources.inspect(...a),download:(...a)=>this.sources.download(...a)},dataDir,getSkill:id=>this.skills().find(s=>s.id===id),progress:e=>this.progress(e)});
    this.engine=new OperationEngine({store:this.store,dataDir,home,roots:()=>[...this.store.all('roots'),...this.protectedRoots],onProgress:e=>this.progress(e)});
    this.lifecycle=new ServiceLifecycle({
      cancel:()=>{
        for(const controller of this.jobs.values())controller.abort();
        const cancelled=this.auth?.cancelLogin?.();
        this.sources.resetAuthState?.();
        return cancelled;
      },
      drain:async()=>{
        await Promise.allSettled([...this.queryPromises.values()]);
        await this.engine.waitForIdle();
      },
      isIdle:()=>!this.queryPromises.size&&!this.engine.pendingCount,
      close:()=>this.store.close()
    });
  }
  progress(event) {this.onProgress({...event,sequence:++this.sequence});}
  cancelled(signal) {if(signal?.aborted)fail('CANCELLED','查询任务已取消，已完成的检查记录会保留。');}
  runQuery(kind,task) {
    if(this.lifecycle.closing)return Promise.reject(Object.assign(new Error('应用正在关闭，无法开始新的查询。'),{code:'SERVICE_CLOSING'}));
    if(this.queryPromises.has(kind))return Promise.reject(Object.assign(new Error('同类查询正在进行，请完成或取消后再试。'),{code:'QUERY_BUSY'}));
    const controller=new AbortController();this.jobs.set(kind,controller);
    const promise=Promise.resolve().then(async()=>{

      try{this.cancelled(controller.signal);this.progress({kind,message:'正在准备查询…'});return await task(controller.signal);}
      finally{if(this.jobs.get(kind)===controller)this.jobs.delete(kind);this.queryPromises.delete(kind);}
    });
    this.queryPromises.set(kind,promise);return promise;
  }
  detachIndex() {
    const records=detachRoots(this.store.all('skills'),this.store.all('roots'));
    this.store.transaction(()=>{for(const skill of records)this.store.put('skills',skill.id,skill);});
  }
  initialize() {return this.lifecycle.run(()=>this.performInitialize());}
  async performInitialize() {
    // 系统与插件归属独立于扫描登记，移除扫描范围不会授予写权限。
    this.protectedRoots=(await discoverRoots({home:this.home,projects:[]})).filter(r=>r.readOnly||r.kind==='plugin');
    if(!this.store.get('settings','main')) this.store.put('settings','main',{theme:'light',fontSize:14,libraryPath:path.join(this.dataDir,'library'),proxy:'',backupDays:30,backupMinimum:3,backupLimitGB:5});
    if(!this.store.get('state','initialized')) {
      for(const root of await discoverRoots({home:this.home,projects:[]})) this.store.put('roots',root.id,root);
      for(const url of ['https://github.com/anthropics/skills','https://github.com/openai/skills']) this.store.put('sources',hashText(url).slice(0,16),{id:hashText(url).slice(0,16),url,enabled:true});
      this.store.put('state','initialized',true);
    }
    this.recovery=await this.engine.recover();
    return this.bootstrap();
  }
  withVersionStatus(skill,updates=this.store.all('updates')) {
    const versionStates=buildVersionStates(skill,updates);
    const result={...skill,versionStates};
    return {...result,versionStatus:getSkillVersionStatus(result)};
  }
  skills() {
    const deployments=this.engine.deployments();
    const updates=this.store.all('updates');
    return this.store.all('skills').filter(skill=>skill.tracked!==false).map(skill=>this.withVersionStatus({...skill,...this.store.get('metadata',skill.id,{}),sourceBinding:this.store.get('source-bindings',skill.id),deployments:deployments.filter(d=>d.targetPath===skill.physicalPath || d.physicalTarget===skill.physicalPath || skill.aliases?.some(a=>a.path===d.targetPath)),sessionEvidence:'none'},updates));
  }
  async githubStatus() {
    const status=this.auth?await this.auth.status():{authenticated:false,user:null,storageAvailable:false,browserAvailable:false,method:null};
    return {...status,rateLimits:this.sources.status?.()||{resources:{}}};
  }
  async requireGitHub() {
    if(!await this.auth?.getCredential())fail('GITHUB_LOGIN_REQUIRED','请先登录 GitHub，再使用在线功能。');
    if(this.lifecycle.closing)fail('SERVICE_CLOSING','应用正在关闭，无法开始新的查询。');
  }
  async bootstrap() {
    const skills=this.skills(); const projects=this.store.all('projects');
    const visibleTargets=new Set(skills.flatMap(s=>getVersionTargets(s).map(d=>d.id)));
    return {github:await this.githubStatus(),skills,roots:this.store.all('roots'),settings:{...this.store.get('settings','main'),projects},projects,sources:this.store.all('sources'),operations:this.engine.history(),adapters:await inspectAdapters({home:this.home,projects:projects.map(p=>p.path)}),updates:this.store.all('updates').filter(u=>visibleTargets.has(u.deploymentId||u.id)),recovery:this.recovery||[],stats:{skills:skills.length,aliases:skills.reduce((n,s)=>n+s.aliases.length,0),managed:this.engine.deployments().length,issues:skills.filter(s=>s.health!=='normal').length},scan:this.store.get('state','lastScan')};
  }
  scan() {return this.runQuery('scan',signal=>this.performScan(signal));}
  async performScan(signal) {
    this.progress({kind:'scan',message:'正在扫描已登记目录…',current:0});
    const roots=this.store.all('roots').filter(r=>r.enabled!==false);
    const result=await scanRoots(roots,{signal,onProgress:e=>this.progress({kind:'scan',...e}),excludePaths:['backups','cache','revisions','staging','credentials'].map(name=>path.join(this.dataDir,name))});
    this.cancelled(signal);
    const configResult=await readConfigStates(result.skills,{home:this.home});
    if(configResult?.issues)result.issues.push(...configResult.issues);
    const records=reconcileScan(this.store.all('skills'),result,this.store.all('roots'));
    const foundPaths=new Set(result.skills.map(s=>s.physicalPath));
    const updates=this.store.all('updates');
    const deployments=this.engine.deployments();
    for(const skill of records) {
      this.cancelled(signal);
      if(skill.tracked===false||!foundPaths.has(skill.physicalPath))continue;
      const associated=deployments.filter(d=>d.targetPath===skill.physicalPath||d.physicalTarget===skill.physicalPath||skill.aliases?.some(a=>a.path===d.targetPath));
      if(associated.length&&skill.management!=='readonly')skill.management='managed';
      const binding=this.store.get('source-bindings',skill.id);
      const ids=new Set([...associated.map(d=>d.id),...(binding?[binding.id]:[])]);
      if(updates.some(u=>ids.has(u.deploymentId||u.id)&&u.localHash)) {
        skill.manifest=await buildManifest(skill.physicalPath,{signal});skill.hash=skill.manifest.hash;
        if(!skill.manifest.complete){skill.health='incomplete';skill.issues=[...(skill.issues||[]),...skill.manifest.issues];}
      }
    }
    this.cancelled(signal);
    this.store.transaction(()=>{
      for(const skill of records) {
        this.store.put('skills',skill.id,skill);
        if(skill.versionEvidenceStale)for(const update of updates)if(update.skillId===skill.id||update.targetPath===skill.physicalPath||skill.aliases?.some(a=>a.path===update.targetPath))this.store.put('updates',update.id,{...update,needsRecheck:true});
        const binding=this.store.get('source-bindings',skill.id);
        if(binding&&skill.tracked!==false&&foundPaths.has(skill.physicalPath)&&binding.physicalPath!==skill.physicalPath)this.store.put('source-bindings',skill.id,{...binding,physicalPath:skill.physicalPath});
      }
      for(const report of result.roots) {
        const root=this.store.get('roots',report.id);if(!root)continue;
        this.store.put('roots',root.id,{...root,status:report.skipped?'expected-missing':!report.complete?'partial':'available',lastScanAt:result.scannedAt});
      }
      this.store.put('state','lastScan',{...result,skills:undefined});
    });
    this.progress({kind:'scan',message:`扫描完成：${result.skills.length} 个物理技能包${result.complete?'':'，有目录需要复核'}`,current:result.skills.length,total:result.skills.length,done:true,issues:result.issues});
    return this.bootstrap();
  }
  async details(id) {
    const skill=this.skills().find(s=>s.id===id); if(!skill) fail('NOT_FOUND','技能不存在，请刷新索引。');
    const manifest=await buildManifest(skill.physicalPath);
    const instruction=path.join(skill.physicalPath,'SKILL.md');
    if((await fs.lstat(instruction)).isSymbolicLink()) fail('INCOMPLETE_SCAN','SKILL.md 是链接，详情不读取包外内容。');
    if((await fs.stat(instruction)).size>2*1024*1024)fail('INCOMPLETE_SCAN','主说明超过预览预算。');
    const raw=await fs.readFile(instruction,'utf8');
    const parsed=parseSkill(raw,instruction);
    const aliasIssues=skill.unverifiedAliases?.length?[{code:'ALIAS_UNVERIFIED',message:'部分历史路径入口尚未复核，请重新扫描相关目录。'}]:[];
    const enriched=this.withVersionStatus({...skill,...parsed,manifest,hash:manifest.hash,raw,health:!manifest.complete||aliasIssues.length?'incomplete':parsed.issues.length?'metadata-error':'normal',issues:[...parsed.issues,...manifest.issues,...aliasIssues]});
    this.store.put('skills',id,enriched); return enriched;
  }
  checkUpdates(args={}) {return this.runQuery('updates',signal=>this.performUpdateCheck(args,signal));}
  async performUpdateCheck({skillIds,tool,scope}={},signal) {
    if(skillIds!==undefined&&(!Array.isArray(skillIds)||skillIds.some(id=>typeof id!=='string')))fail('INVALID_ARGUMENT','技能筛选参数无效。');
    const skills=this.skills();
    const selected=skillIds===undefined?null:new Set(skillIds);
    const candidates=[];
    const targets=new Map(skills.flatMap(skill=>getVersionTargets(skill).map(target=>[target.id,target])));
    for(const deployment of targets.values()) {
      if(!hasVersionSource(deployment.source))continue;
      const skill=skills.find(s=>s.deployments.some(d=>d.id===deployment.id)||s.sourceBinding?.id===deployment.id);
      if(selected&&(!skill||!selected.has(skill.id)))continue;
      const versionState=skill?.versionStates.find(s=>s.deploymentId===deployment.id)||{tool:deployment.tool,scope:deployment.scope};
      if(!versionStateMatches(versionState,{tool,scope}))continue;
      candidates.push({deployment,skill});
    }
    if(candidates.some(item=>!item.skill?.pinned))await this.requireGitHub();
    const results=[];
    const inspections=new Map();
    for(const {deployment,skill} of candidates) {
      this.cancelled(signal);
      const result={id:deployment.id,deploymentId:deployment.trackingOnly?undefined:deployment.id,bindingId:deployment.trackingOnly?deployment.id:undefined,trackingOnly:!!deployment.trackingOnly,skillId:skill?.id,name:skill?.alias||skill?.name||path.basename(deployment.targetPath),targetPath:deployment.targetPath,tool:deployment.tool,scope:deployment.scope,checkedAt:new Date().toISOString(),source:deployment.source,checkedSource:structuredClone(deployment.source)};
      if(skill?.pinned) {const pinned={...result,status:'pinned'};results.push(pinned);this.store.put('updates',pinned.id,pinned);continue;}
      try {
        this.progress({kind:'updates',message:`检查更新：${result.name}`,current:results.length});
        const old=deployment.source;
        const inspectKey=JSON.stringify([old.repositoryId,old.url,old.ref]);
        if(!inspections.has(inspectKey))inspections.set(inspectKey,this.sources.inspect(old.url,{ref:old.ref,forceRefresh:true,signal}));
        const inspection=await inspections.get(inspectKey);
        if(inspection.stale) fail('SOURCE_UNAVAILABLE','来源缓存已过期，不能据此判断最新版本。');
        if(old.repositoryId && String(old.repositoryId)!==String(inspection.repository.id))fail('SOURCE_IDENTITY_CHANGED','仓库身份已变化，不能自动改绑来源。');
        const candidate=inspection.skills.find(s=>s.path===old.subdir);
        if(!candidate) fail('SOURCE_UNAVAILABLE','来源子目录已移动或删除，请确认新位置。');
        const download=await this.sources.download({...candidate,repository:inspection.repository,commit:inspection.commit,ref:inspection.ref},{signal});
        const local=await buildManifest(deployment.targetPath,{signal}), remote=await buildManifest(download.path,{signal});
        this.cancelled(signal);
        if(!this.isCurrentUpdateTarget(deployment,skill))continue;
        if(skill) {
          const indexed=this.store.get('skills',skill.id);
          this.store.put('skills',skill.id,{...indexed,manifest:local,hash:local.hash});
        }
        const comparison=deployment.trackingOnly&&!deployment.baseline?compareSourceContent(local,remote):compareVersions(deployment.baseline,local,remote);
        Object.assign(result,comparison,{baselineHash:deployment.baselineHash,localHash:local.hash,remoteHash:remote.hash,remotePath:download.path,source:download.source});
        if(deployment.trackingOnly) {
          if(local.complete&&remote.complete&&local.hash===remote.hash) {
            const binding=this.store.get('source-bindings',skill.id);
            this.store.put('source-bindings',skill.id,{...binding,baseline:remote,baselineHash:remote.hash,revisionPath:download.path,source:download.source});
            result.baselineHash=remote.hash;result.status='current';deployment.source=download.source;deployment.baselineHash=remote.hash;
          }
        } else if(result.status==='aligned') {
          // 内容已相同，仅记录关联；不写任何技能文件。
          this.store.put('deployments',deployment.id,{...deployment,baseline:remote,baselineHash:remote.hash,revisionPath:download.path,source:download.source});
          deployment.baselineHash=remote.hash;deployment.source=download.source;
        }
      } catch(e) {this.cancelled(signal);if(e.code==='CANCELLED')throw e;Object.assign(result,{status:'source-unavailable',error:{code:e.code||'SOURCE_UNAVAILABLE',message:e.message,details:e.details||{}}});}
      if(!this.isCurrentUpdateTarget(deployment,skill))continue;
      results.push(result);this.store.put('updates',result.id,result);
    }
    this.store.transaction(()=>{
      const activeIds=new Set([...this.engine.deployments().map(d=>d.id),...this.store.all('source-bindings').map(b=>b.id)]);
      for(const old of this.store.all('updates'))if(!activeIds.has(old.deploymentId||old.id))this.store.delete('updates',old.id);

    });
    this.progress({kind:'updates',message:`更新检查完成：${results.length} 个安装`,done:true}); return results;
  }
  isCurrentUpdateTarget(target,skill) {
    if(!skill||!this.skills().some(s=>s.id===skill.id))return false;
    const current=target.trackingOnly?this.store.get('source-bindings',skill.id):this.store.get('deployments',target.id);
    if(!current||current.id!==target.id)return false;
    // 查询期间解绑、改绑或重新安装时，旧结果不能恢复或覆盖新关联。
    return JSON.stringify(current.source)===JSON.stringify(target.source)
      && (target.trackingOnly?current.linkedAt===target.linkedAt&&current.physicalPath===target.physicalPath:current.targetPath===target.targetPath&&current.baselineHash===target.baselineHash);
  }
  call(method,args={}) {return this.lifecycle.run(()=>this.dispatch(method,args));}
  async dispatch(method,args={}) {
    args=parseIpcArgs(method,args);
    switch(method) {
      case 'bootstrap': return this.bootstrap();
      case 'github.status':return this.githubStatus();
      case 'github.loginToken': {
        if(!this.auth)fail('AUTH_UNAVAILABLE','桌面凭据服务未连接。');
        await this.auth.loginToken(args.token);this.sources.resetAuthState?.();return this.githubStatus();
      }
      case 'github.loginBrowser': {
        if(!this.auth)fail('AUTH_UNAVAILABLE','桌面凭据服务未连接。');
        await this.auth.loginBrowser({username:args.username});this.sources.resetAuthState?.();return this.githubStatus();
      }
      case 'github.logout': {
        await this.auth?.logout();this.sources.resetAuthState?.();return this.githubStatus();
      }
      case 'github.cancelLogin':await this.auth?.cancelLogin?.();return this.githubStatus();
      case 'github.openTokenPage':return this.openExternal?.('https://github.com/settings/personal-access-tokens/new');
      case 'scan': case 'scan.start': return this.scan();
      case 'jobs.cancel': {
        if(this.operationCount)return {cancelled:false,message:'文件操作尚未完成，不能取消或伪装为回滚。'};
        const controller=this.jobs.get(args.id||'scan');if(!controller)return {cancelled:false,message:'该任务已结束或不可取消。'};
        controller.abort();return {cancelled:true,message:'正在停止查询；原文件不受影响。'};
      }
      case 'storage.usage': {
        const settings=this.store.get('settings','main',{});
        const report=await inspectStorage(this.dataDir,{limitGB:settings.backupLimitGB});
        if(settings.libraryPath&&path.resolve(settings.libraryPath)!==path.resolve(this.dataDir,'library'))report.issues.push({code:'EXTERNAL_LIBRARY',message:'集中库位于应用数据目录之外，本次用量未包含该外部位置。'});
        return report;
      }
      case 'skills.source.inspect':await this.requireGitHub();return this.runQuery('download',signal=>this.bindings.inspect(args.id,args.url,{ref:args.ref,signal}));
      case 'skills.source.preview':await this.requireGitHub();return this.runQuery('download',signal=>this.bindings.preview(args.id,args.candidate,{signal}));
      case 'skills.source.bind':return this.bindings.bind(args.previewId);
      case 'skills.source.unbind':return this.bindings.unbind(args.id);
      case 'skills.detail': return this.details(args.id);
      case 'skills.organize': {
        const skill=this.store.get('skills',args.id); if(!skill) fail('NOT_FOUND','技能不存在。');
        const meta=this.store.get('metadata',args.id,{});
        for(const key of ['alias','tags','favorite','pinned']) if(args[key]!==undefined) meta[key]=args[key];
        if(typeof meta.alias==='string') meta.alias=meta.alias.slice(0,200);
        if(meta.tags) meta.tags=meta.tags.filter(x=>typeof x==='string').slice(0,50).map(x=>x.slice(0,50));
        this.store.put('metadata',args.id,meta);return {...skill,...meta};
      }
      case 'duplicates.analyze':return this.runQuery('duplicates',async signal=>{
        const skills=this.skills().filter(s=>s.health!=='missing');
        for(let i=0;i<skills.length;i++) {
          this.cancelled(signal);this.progress({kind:'duplicates',message:`比较完整技能包 ${i+1}/${skills.length}`,current:i,total:skills.length});
          const manifest=await buildManifest(skills[i].physicalPath,{signal});this.cancelled(signal);
          skills[i]={...skills[i],manifest,hash:manifest.hash};this.store.put('skills',skills[i].id,skills[i]);
        }
        this.progress({kind:'duplicates',message:'完整包比较已完成',done:true});return analyzeDuplicates(skills);
      });
      case 'roots.add': {
        const p=path.resolve(args.path); if(!(await fs.stat(p)).isDirectory()) fail('INVALID_PATH','请选择目录。');
        if(inside(this.dataDir,p) && !inside(this.store.get('settings','main').libraryPath,p)) fail('INVALID_PATH','不能把应用快照或缓存作为技能发现目录。');
        const root={id:hashText(p).slice(0,20),path:p,kind:args.kind||'manual',tools:args.tools||[],scope:args.scope||'user',enabled:true};
        this.store.put('roots',root.id,root);return root;
      }
      case 'roots.remove': {
        this.store.transaction(()=>{recordRegistrationRemoval(this,{id:args.id,path:this.store.get('roots',args.id)?.path});this.store.delete('roots',args.id);});
        this.detachIndex();return true;
      }
      case 'projects.add': {
        const p=await fs.realpath(args.path); if(!(await fs.stat(p)).isDirectory())fail('INVALID_PATH','请选择项目目录。');
        const project={id:hashText(p).slice(0,20),path:p,name:path.basename(p)};this.store.put('projects',project.id,project);
        for(const root of await discoverRoots({home:this.home,projects:[p]})) this.store.put('roots',root.id,root);
        return project;
      }
      case 'projects.remove': {
        const project=this.store.get('projects',args.id);if(!project)fail('NOT_FOUND','项目登记不存在。');
        this.store.transaction(()=>{recordRegistrationRemoval(this,{scope:project.path,path:project.path});this.store.delete('projects',args.id);for(const root of this.store.all('roots'))if(root.scope===project.path)this.store.delete('roots',root.id);});
        this.detachIndex();return true;
      }
      case 'settings.save': {
        const before=this.store.get('settings','main');
        let next={...before};
        for(const key of ['theme','fontSize','libraryPath','proxy','backupDays','backupMinimum','backupLimitGB'])if(args[key]!==undefined)next[key]=args[key];
        // 兼容旧库中曾保存的数字字符串；新请求已在入口严格验证。
        for(const key of ['fontSize','backupDays','backupMinimum','backupLimitGB'])if(typeof next[key]==='string'&&next[key].trim())next[key]=Number(next[key]);
        next=parseIpcArgs('settings.save',next);
        if(next.proxy && !/^(https?|socks5):\/\/[^\s@]+$/.test(next.proxy))fail('INVALID_PROXY','请输入不含凭据的 HTTP 或 SOCKS5 代理地址。');
        if(next.libraryPath) next.libraryPath=path.resolve(next.libraryPath);

        await this.onSettings(next);this.store.put('settings','main',next);return next;
      }
      case 'sources.add': {
        const url=new URL(args.url);if(url.hostname!=='github.com'||url.protocol!=='https:'||url.username||url.password)fail('INVALID_SOURCE','仅支持公开 GitHub HTTPS 仓库链接。');
        const id=hashText(url.href).slice(0,20),source={id,url:url.href,enabled:true};this.store.put('sources',id,source);return source;
      }
      case 'sources.remove':this.store.delete('sources',args.id);return true;
      case 'sources.search':await this.requireGitHub();return this.sources.search(args.query,args.page||1,{forceRefresh:args.forceRefresh===true});
      case 'sources.inspect':await this.requireGitHub();return this.sources.inspect(args.url,{ref:args.ref,forceRefresh:args.forceRefresh===true});
      case 'sources.preview': {
        await this.requireGitHub();return this.runQuery('download',async signal=>{
          const download=await this.sources.download(args.candidate,{signal,onProgress:e=>this.progress({kind:'download',message:'正在下载技能预览…',...e})});
          const result=await scanRoots([{id:'download',path:download.path,kind:'library',tools:[],scope:'preview'}],{hashPackages:true,signal});
          this.cancelled(signal);return {...download,skill:result.skills[0],manifest:result.skills[0]?.manifest};
        });
      }
      case 'updates.check':return this.checkUpdates(args);
      case 'operations.plan':return this.engine.plan(args);
      case 'operations.execute': {
        this.operationCount++;try {return await executeWithRefresh(this,args);}finally{this.operationCount--;}
      }
      case 'operations.refresh':return executeWithRefresh(this,args,true);
      case 'operations.history':return this.engine.history();
      case 'operations.status':return this.store.get('operations',args.id);
      case 'migration.preview': {
        const report=await previewMigration(args.path);this.store.put('migration-previews',report.id,report);return report;
      }
      case 'migration.import': {
        const report=this.store.get('migration-previews',args.id);if(!report)fail('NOT_FOUND','请先预览迁移报告。');
        return importMigration(report,this.store);
      }
      case 'dialog.directory':return this.chooseDirectory?.()||null;
      case 'dialog.file':return this.chooseFile?.()||null;
      case 'files.compare': {
        const binding=args.bindingId?this.store.all('source-bindings').find(b=>b.id===args.bindingId):null;
        const boundSkill=binding?this.skills().find(s=>s.id===binding.skillId):null;
        if(binding&&!boundSkill)fail('NOT_FOUND','该来源已不在当前扫描范围。');
        const deployment=binding?{...binding,targetPath:boundSkill.physicalPath}:this.store.get('deployments',args.deploymentId);
        if(!deployment)fail('NOT_FOUND','此安装没有可靠的比较基线。');
        const update=this.store.get('updates',deployment.id);
        const remotePath=args.remotePath||update?.remotePath;
        if(remotePath && (!inside(this.dataDir,remotePath)||remotePath!==update?.remotePath))fail('INVALID_PATH','远端版本不在本次更新记录中。');
        const relativePath=args.relativePath||'SKILL.md';
        const localManifest=await buildManifest(deployment.targetPath);
        const remoteManifest=remotePath?await buildManifest(remotePath):null;
        const [baseline,local,remote]=await Promise.all([
          readRevisionFile(deployment.revisionPath,relativePath,deployment.baseline),
          readRevisionFile(deployment.targetPath,relativePath,localManifest),
          readRevisionFile(remotePath,relativePath,remoteManifest)
        ]);
        return {path:relativePath,baseline,local,remote};
      }
      case 'files.open': {
        const p=await resolveAllowedOpenPath(args.path,[...this.store.all('roots').map(r=>r.path),this.dataDir]);
        return this.openPath?.(p);
      }
      case 'links.open': {
        const url=new URL(args.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)fail('INVALID_URL','只允许打开 HTTP(S) 网页。');return this.openExternal?.(url.href);
      }
      default:fail('UNKNOWN_METHOD','此操作不可用。');
    }
  }
  shutdown() {return this.lifecycle.shutdown();}
  close() {return this.lifecycle.close();}
}
