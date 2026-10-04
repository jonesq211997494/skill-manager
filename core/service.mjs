import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { scanRoots, buildManifest, analyzeDuplicates } from './scanner.mjs';
import { discoverRoots, inspectAdapters, readConfigStates } from './adapters.mjs';
import { SourceService } from './sources.mjs';
import { OperationEngine, compareVersions, hashText, inside } from './operations.mjs';
import { previewMigration, importMigration } from './migration.mjs';
import { fail } from './errors.mjs';
import { readRevisionFile } from './diff.mjs';
import { buildVersionStates, getSkillVersionStatus, versionStateMatches, hasVersionSource } from '../shared/version-status.mjs';

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
    this.jobs=new Map(); this.sequence=0;
    this.engine=new OperationEngine({store:this.store,dataDir,home,roots:()=>this.store.all('roots'),onProgress:e=>this.progress(e)});
  }
  progress(event) {this.onProgress({...event,sequence:++this.sequence});}
  async initialize() {
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
    return this.store.all('skills').map(skill=>this.withVersionStatus({...skill,...this.store.get('metadata',skill.id,{}),deployments:deployments.filter(d=>d.targetPath===skill.physicalPath || d.physicalTarget===skill.physicalPath || skill.aliases?.some(a=>a.path===d.targetPath)),sessionEvidence:'none'},updates));
  }
  async githubStatus() {
    const status=this.auth?await this.auth.status():{authenticated:false,user:null,storageAvailable:false,browserAvailable:false,method:null};
    return {...status,rateLimits:this.sources.status?.()||{resources:{}}};
  }
  async requireGitHub() {
    if(!await this.auth?.getCredential())fail('GITHUB_LOGIN_REQUIRED','请先登录 GitHub，再使用在线功能。');
  }
  async bootstrap() {
    const skills=this.skills(); const projects=this.store.all('projects');
    return {github:await this.githubStatus(),skills,roots:this.store.all('roots'),settings:{...this.store.get('settings','main'),projects},projects,sources:this.store.all('sources'),operations:this.engine.history(),adapters:await inspectAdapters({home:this.home,projects:projects.map(p=>p.path)}),updates:this.store.all('updates'),recovery:this.recovery||[],stats:{skills:skills.length,aliases:skills.reduce((n,s)=>n+s.aliases.length,0),managed:this.engine.deployments().length,issues:skills.filter(s=>s.health!=='normal').length},scan:this.store.get('state','lastScan')};
  }
  async scan() {
    if(this.scanning) return this.scanning;
    const controller=new AbortController(); this.jobs.set('scan',controller);
    this.scanning=(async()=>{
      try {
        this.progress({kind:'scan',message:'正在扫描已登记目录…',current:0});
        const roots=this.store.all('roots').filter(r=>r.enabled!==false);
        const result=await scanRoots(roots,{signal:controller.signal,onProgress:e=>this.progress({kind:'scan',...e}),excludePaths:['backups','cache','revisions','staging','credentials'].map(name=>path.join(this.dataDir,name))});
        const configResult=await readConfigStates(result.skills,{home:this.home});
        if(Array.isArray(configResult)) result.skills=configResult;
        if(configResult?.issues) result.issues.push(...configResult.issues);
        const previous=this.store.all('skills');
        const deployments=this.engine.deployments();
        const managedPaths=new Set(deployments.map(d=>d.targetPath));
        const checkedIds=new Set(this.store.all('updates').filter(u=>u.localHash&&u.checkedAt).map(u=>u.deploymentId||u.id));
        for(const skill of result.skills) {
          const old=previous.find(s=>s.physicalPath===skill.physicalPath && managedPaths.has(s.physicalPath));
          if(old) skill.id=old.id;
          if(managedPaths.has(skill.physicalPath)) skill.management='managed';
          // 仅复核曾有版本证据的安装包；元数据刷新不访问 GitHub。
          if(deployments.some(d=>checkedIds.has(d.id)&&(d.targetPath===skill.physicalPath||d.physicalTarget===skill.physicalPath||skill.aliases?.some(a=>a.path===d.targetPath)))) {
            skill.manifest=await buildManifest(skill.physicalPath,{signal:controller.signal});
            skill.hash=skill.manifest.hash;
          }
        }
        this.store.transaction(()=>{
          for(const skill of result.skills) this.store.put('skills',skill.id,skill);
          const seen=new Set(result.skills.map(s=>s.id));
          // 未完成扫描不能清空旧索引；完整扫描的缺失项保留明确标记。
          for(const old of this.store.all('skills')) if(!seen.has(old.id)) this.store.put('skills',old.id,{...old,health:result.complete?'missing':'incomplete',issues:[{code:result.complete?'MISSING':'INCOMPLETE_SCAN',message:result.complete?'本次扫描未找到该目录':'扫描未完成，保留上次索引'}]});
          this.store.put('state','lastScan',{...result,skills:undefined});
        });
        this.progress({kind:'scan',message:`扫描完成：${result.skills.length} 个物理技能包${result.complete?'':'，有目录需要复核'}`,current:result.skills.length,total:result.skills.length,done:true,issues:result.issues});
        return this.bootstrap();
      } finally {this.jobs.delete('scan');this.scanning=null;}
    })();
    return this.scanning;
  }
  async details(id) {
    const skill=this.skills().find(s=>s.id===id); if(!skill) fail('NOT_FOUND','技能不存在，请刷新索引。');
    const manifest=await buildManifest(skill.physicalPath);
    const instruction=path.join(skill.physicalPath,'SKILL.md');
    if((await fs.lstat(instruction)).isSymbolicLink()) fail('INCOMPLETE_SCAN','SKILL.md 是链接，详情不读取包外内容。');
    if((await fs.stat(instruction)).size>2*1024*1024)fail('INCOMPLETE_SCAN','主说明超过预览预算。');
    const raw=await fs.readFile(instruction,'utf8');
    const enriched=this.withVersionStatus({...skill,manifest,hash:manifest.hash,raw});
    this.store.put('skills',id,enriched); return enriched;
  }
  async checkUpdates({skillIds,tool,scope}={}) {
    if(skillIds!==undefined&&(!Array.isArray(skillIds)||skillIds.some(id=>typeof id!=='string')))fail('INVALID_ARGUMENT','技能筛选参数无效。');
    const skills=this.skills();
    const selected=skillIds===undefined?null:new Set(skillIds);
    const candidates=[];
    for(const deployment of this.engine.deployments()) {
      if(!hasVersionSource(deployment.source))continue;
      const skill=skills.find(s=>s.deployments.some(d=>d.id===deployment.id));
      if(selected&&(!skill||!selected.has(skill.id)))continue;
      const versionState=skill?.versionStates.find(s=>s.deploymentId===deployment.id)||{tool:deployment.tool,scope:deployment.scope};
      if(!versionStateMatches(versionState,{tool,scope}))continue;
      candidates.push({deployment,skill});
    }
    if(candidates.some(item=>!item.skill?.pinned))await this.requireGitHub();
    const results=[];
    const inspections=new Map();
    for(const {deployment,skill} of candidates) {
      const result={id:deployment.id,deploymentId:deployment.id,name:skill?.alias||skill?.name||path.basename(deployment.targetPath),targetPath:deployment.targetPath,tool:deployment.tool,scope:deployment.scope,checkedAt:new Date().toISOString(),source:deployment.source,checkedSource:structuredClone(deployment.source)};
      if(skill?.pinned) {results.push({...result,status:'pinned'});continue;}
      try {
        this.progress({kind:'updates',message:`检查更新：${result.name}`,current:results.length});
        const old=deployment.source;
        const inspectKey=JSON.stringify([old.repositoryId,old.url,old.ref]);
        if(!inspections.has(inspectKey))inspections.set(inspectKey,this.sources.inspect(old.url,{ref:old.ref,forceRefresh:true}));
        const inspection=await inspections.get(inspectKey);
        if(inspection.stale) fail('SOURCE_UNAVAILABLE','来源缓存已过期，不能据此判断最新版本。');
        if(old.repositoryId && String(old.repositoryId)!==String(inspection.repository.id))fail('SOURCE_IDENTITY_CHANGED','仓库身份已变化，不能自动改绑来源。');
        const candidate=inspection.skills.find(s=>s.path===old.subdir);
        if(!candidate) fail('SOURCE_UNAVAILABLE','来源子目录已移动或删除，请确认新位置。');
        const download=await this.sources.download({...candidate,repository:inspection.repository,commit:inspection.commit,ref:inspection.ref});
        const local=await buildManifest(deployment.targetPath), remote=await buildManifest(download.path);
        if(skill) {
          const indexed=this.store.get('skills',skill.id);
          this.store.put('skills',skill.id,{...indexed,manifest:local,hash:local.hash});
        }
        Object.assign(result,compareVersions(deployment.baseline,local,remote),{baselineHash:deployment.baselineHash,localHash:local.hash,remoteHash:remote.hash,remotePath:download.path,source:download.source});
        if(result.status==='aligned') {
          // 内容已相同，仅记录关联；不写任何技能文件。
          this.store.put('deployments',deployment.id,{...deployment,baseline:remote,baselineHash:remote.hash,revisionPath:download.path,source:download.source});
        }
      } catch(e) {Object.assign(result,{status:'source-unavailable',error:{code:e.code||'SOURCE_UNAVAILABLE',message:e.message,details:e.details||{}}});}
      results.push(result);
    }
    this.store.transaction(()=>{
      const activeIds=new Set(this.engine.deployments().map(d=>d.id));
      for(const old of this.store.all('updates'))if(!activeIds.has(old.deploymentId||old.id))this.store.delete('updates',old.id);
      for(const row of results)this.store.put('updates',row.id,row);
    });
    this.progress({kind:'updates',message:`更新检查完成：${results.length} 个安装`,done:true}); return results;
  }
  async call(method,args={}) {
    if(!args || typeof args!=='object') fail('INVALID_ARGUMENT','请求参数无效。');
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
      case 'jobs.cancel': this.jobs.get(args.id||'scan')?.abort();return {cancelled:true};
      case 'skills.detail': return this.details(args.id);
      case 'skills.organize': {
        const skill=this.store.get('skills',args.id); if(!skill) fail('NOT_FOUND','技能不存在。');
        const meta=this.store.get('metadata',args.id,{});
        for(const key of ['alias','tags','favorite','pinned']) if(args[key]!==undefined) meta[key]=args[key];
        if(typeof meta.alias==='string') meta.alias=meta.alias.slice(0,200);
        if(meta.tags) meta.tags=meta.tags.filter(x=>typeof x==='string').slice(0,50).map(x=>x.slice(0,50));
        this.store.put('metadata',args.id,meta);return {...skill,...meta};
      }
      case 'duplicates.analyze': {
        const skills=this.skills().filter(s=>s.health!=='missing');
        for(let i=0;i<skills.length;i++) {
          this.progress({kind:'duplicates',message:`比较完整技能包 ${i+1}/${skills.length}`,current:i,total:skills.length});
          const manifest=await buildManifest(skills[i].physicalPath);skills[i]={...skills[i],manifest,hash:manifest.hash};this.store.put('skills',skills[i].id,skills[i]);
        }
        this.progress({kind:'duplicates',message:'完整包比较已完成',done:true});return analyzeDuplicates(skills);
      }
      case 'roots.add': {
        const p=path.resolve(args.path); if(!(await fs.stat(p)).isDirectory()) fail('INVALID_PATH','请选择目录。');
        if(inside(this.dataDir,p) && !inside(this.store.get('settings','main').libraryPath,p)) fail('INVALID_PATH','不能把应用快照或缓存作为技能发现目录。');
        const root={id:hashText(p).slice(0,20),path:p,kind:args.kind||'manual',tools:args.tools||[],scope:args.scope||'user',enabled:true};
        this.store.put('roots',root.id,root);return root;
      }
      case 'roots.remove':this.store.delete('roots',args.id);return true;
      case 'projects.add': {
        const p=await fs.realpath(args.path); if(!(await fs.stat(p)).isDirectory())fail('INVALID_PATH','请选择项目目录。');
        const project={id:hashText(p).slice(0,20),path:p,name:path.basename(p)};this.store.put('projects',project.id,project);
        for(const root of await discoverRoots({home:this.home,projects:[p]})) this.store.put('roots',root.id,root);
        return project;
      }
      case 'settings.save': {
        const before=this.store.get('settings','main'), next={...before};
        for(const key of ['theme','fontSize','libraryPath','proxy','backupDays','backupMinimum','backupLimitGB'])if(args[key]!==undefined)next[key]=args[key];
        next.fontSize=Math.max(12,Math.min(20,Number(next.fontSize)||14));
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
        await this.requireGitHub();
        const download=await this.sources.download(args.candidate,{onProgress:e=>this.progress({kind:'download',...e})});
        const result=await scanRoots([{id:'download',path:download.path,kind:'library',tools:[],scope:'preview'}],{hashPackages:true});
        return {...download,skill:result.skills[0],manifest:result.skills[0]?.manifest};
      }
      case 'updates.check':return this.checkUpdates(args);
      case 'operations.plan':return this.engine.plan(args);
      case 'operations.execute': {
        const result=await this.engine.execute(args.planId,args.digest);
        for(const step of result.steps.filter(s=>s.status==='completed')) {
          const p=step.tool==='library'?this.store.get('settings','main').libraryPath:path.dirname(step.targetPath);
          const id=hashText(p).slice(0,20);this.store.put('roots',id,{id,path:p,kind:step.tool==='library'?'library':'active',tools:step.tools,scope:step.scope,enabled:true});
        }
        for(const step of result.steps.filter(s=>s.status==='completed')) {
          for(const update of this.store.all('updates'))if(update.targetPath===step.targetPath)this.store.put('updates',update.id,{...update,needsRecheck:true});
        }
        await this.scan();return result;
      }
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
        const deployment=this.store.get('deployments',args.deploymentId);
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
        const p=path.resolve(args.path);const stat=await fs.stat(p);
        if(!stat.isDirectory() && path.extname(p).toLowerCase()!=='.md')fail('INVALID_PATH','只允许打开目录和 Markdown 文件。');
        if(![...this.store.all('roots').map(r=>r.path),this.dataDir].some(root=>inside(root,p)))fail('INVALID_PATH','路径不在已登记目录中。');
        return this.openPath?.(p);
      }
      case 'links.open': {
        const url=new URL(args.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)fail('INVALID_URL','只允许打开 HTTP(S) 网页。');return this.openExternal?.(url.href);
      }
      default:fail('UNKNOWN_METHOD','此操作不可用。');
    }
  }
  close() {this.auth?.cancelLogin?.();this.sources.resetAuthState?.();this.store.close();}
}
