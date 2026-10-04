import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildManifest } from './scanner.mjs';
import { fail } from './errors.mjs';

export const hashText = value => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
export function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function containsVcs(dir) {
  const pending=[dir];
  while(pending.length) {
    for(const entry of await fs.readdir(pending.pop(),{withFileTypes:true})) {
      if(entry.name === '.git') return true;
      if(entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(entry.parentPath,entry.name));
    }
  }
  return false;
}
const exists = async p => { try { await fs.lstat(p); return true; } catch(e) { if (e.code === 'ENOENT') return false; throw e; } };
async function dirIdentity(p) {
  const stat = await fs.stat(p, {bigint:true});
  return {real: await fs.realpath(p), device: String(stat.dev), inode:String(stat.ino)};
}
async function anchors(p) {
  const result = [];
  for (let current = path.resolve(p); ; current = path.dirname(current)) {
    if (await exists(current)) result.push({path:current, ...await dirIdentity(current)});
    if (path.dirname(current) === current) break;
  }
  return result;
}
async function assertAnchors(saved) {
  for (const item of saved) {
    try {
      const current = await dirIdentity(item.path);
      if (current.real !== item.real || current.device !== item.device || current.inode !== item.inode) fail('PLAN_STALE', '目录或链接目标已变化，请重新预览。', {path:item.path});
    } catch(e) { if(e.code === 'PLAN_STALE') throw e; fail('PLAN_STALE', '计划中的父目录已不可访问。', {path:item.path}); }
  }
}
export async function fingerprint(dir,manifestOptions={}) {
  if (!await exists(dir)) return {exists:false, hash:null};
  const stat = await fs.lstat(dir, {bigint:true});
  if (stat.isSymbolicLink()) return {exists:true, link:true, target:await fs.readlink(dir), identity:await dirIdentity(dir), hash:null};
  if (!stat.isDirectory()) return {exists:true, file:true, hash:null};
  const manifest = await buildManifest(dir,manifestOptions);
  return {exists:true, hash:manifest.hash, complete:manifest.complete, identity:await dirIdentity(dir), manifest};
}
function equalFingerprint(a,b) {
  return a.exists === b.exists && a.hash === b.hash && a.link === b.link && a.file === b.file && a.target === b.target && JSON.stringify(a.identity) === JSON.stringify(b.identity);
}
function validateName(name) {
  if (!name || name.length > 150 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail('INVALID_NAME', '技能目录名不适用于 Windows。');
  return name;
}

// 所有实际文件变更统一经过持久化计划和前置条件核验。
export class OperationEngine {
  constructor({store,dataDir,home,roots=()=>[],onProgress=()=>{}}) {
    Object.assign(this,{store,dataDir,home,roots,onProgress}); this.queue = Promise.resolve();
  }
  history() { return this.store.all('operations').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); }
  deployments() { return this.store.all('deployments'); }
  targetFor(target, name) {
    if (!['codex','claude','cursor'].includes(target.tool)) fail('INVALID_TARGET','请选择支持的目标工具。');
    const base = target.scope === 'user' ? this.home : path.resolve(target.scope || '');
    if (target.scope !== 'user' && !this.store.all('projects').some(p=>p.path === base)) fail('INVALID_SCOPE','请先在设置中登记项目目录。');
    const folder = {codex:'.agents',claude:'.claude',cursor:'.cursor'}[target.tool];
    const root = target.tool === 'claude' && target.scope === 'user' && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : path.join(base,folder);
    return path.join(root,'skills',validateName(name));
  }
  async assertWritable(targetPath) {
    const actual = await this.resolveFuture(targetPath);
    for (const root of this.roots()) {
      if (!(root.readOnly || root.kind === 'plugin')) continue;
      const real = await fs.realpath(root.path).catch(()=>path.resolve(root.path));
      if (inside(real,actual)) fail('READ_ONLY_OWNER','系统或插件拥有此目录，只允许查看。',{path:targetPath});
    }
    const found = this.store.all('skills').find(s => s.management === 'readonly' && inside(s.physicalPath,actual));
    if (found) fail('READ_ONLY_OWNER','此技能由插件或系统管理，只允许查看。');
  }
  async resolveFuture(p) {
    let current = path.resolve(p); const tail=[];
    while(!await exists(current)) { tail.unshift(path.basename(current)); const next=path.dirname(current); if(next===current) break; current=next; }
    return path.join(await fs.realpath(current),...tail);
  }
  async sourceManifest(sourcePath) {
    const rootStat = await fs.lstat(sourcePath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('TARGET_SHARED','请使用技能的真实目录；不会写入或跟随链接目标。');
    const manifest = await buildManifest(sourcePath);
    if (!manifest.complete) fail('INCOMPLETE_SCAN','技能包包含未核验文件或链接，不能执行文件变更。',{issues:manifest.issues});
    if (!manifest.files.some(f=>f.path === 'SKILL.md' && f.type !== 'link')) fail('INVALID_PACKAGE','请选择根部包含 SKILL.md 的技能目录。');
    return manifest;
  }
  async plan(intent) {
    const plan = {id:randomUUID(),kind:intent.kind,createdAt:stamp(),summary:'',steps:[],blockers:[],warnings:[]};
    const add = async (action, sourcePath, targetPath, extra={}) => {
      await this.assertWritable(targetPath);
      const before = await fingerprint(targetPath);
      if (before.link || before.file) fail('TARGET_SHARED','目标是链接或非目录；请保留原位并选择独立安装位置。',{path:targetPath});
      if (before.exists && !before.complete) fail('INCOMPLETE_SCAN','目标目录无法完整核验，已阻止变更。');
      if (before.exists && await containsVcs(targetPath)) fail('TARGET_REPOSITORY','目标包含 Git 工作区，请先将技能与版本库分开管理；保留当前文件。');
      let source = null;
      if (sourcePath) {
        try { source = await this.sourceManifest(sourcePath); }
        catch (error) {
          if (action === 'restore') fail('SNAPSHOT_CORRUPT','恢复快照无法完整核验，已保留当前文件，请先检查快照。');
          throw error;
        }
      }
      if (action === 'restore' && sourcePath && (!extra.restoreSnapshotHash || source.hash !== extra.restoreSnapshotHash || await containsVcs(sourcePath)))
        fail('SNAPSHOT_CORRUPT','恢复快照与原操作保存的内容不一致，已阻止恢复。');
      const sourceAnchors = sourcePath ? await anchors(sourcePath) : [];
      const parentAnchors = await anchors(path.dirname(targetPath));
      const physicalTarget = await this.resolveFuture(targetPath);
      if (plan.steps.some(s=>s.physicalTarget===physicalTarget)) fail('TARGET_CONFLICT','同一批计划包含重复的物理目标。');
      if (sourcePath) {
        const realSource=await fs.realpath(sourcePath);
        if (inside(realSource,physicalTarget) || inside(physicalTarget,realSource)) fail('TARGET_CONFLICT','来源与目标的实际目录不能重叠。');
      }
      const known = this.deployments().filter(d=>d.targetPath === targetPath || d.physicalTarget === physicalTarget);
      const inferred = targetPath.includes(`${path.sep}.agents${path.sep}`) ? ['codex','cursor'] : targetPath.includes(`${path.sep}.claude${path.sep}`) ? ['claude','cursor'] : ['cursor'];
      plan.steps.push({id:randomUUID(),action,sourcePath,targetPath,physicalTarget,before,beforeHash:before.hash,afterHash:source?.hash || null,manifest:source,sourceAnchors,parentAnchors,bytes:source?.bytes||before.manifest?.bytes||0,tools:[...new Set([...inferred,...known.map(d=>d.tool)])],previousDeployments:known,...extra});
    };
    try {
      if (intent.kind === 'install' || intent.kind === 'import') {
        const sourceSkills = intent.skillIds?.map(id=>{const s=this.store.get('skills',id); if(!s) fail('NOT_FOUND','技能已不在索引中。'); if(s.management==='readonly') fail('READ_ONLY_OWNER','此技能由系统或插件管理。'); return {path:s.physicalPath,id:s.id,name:path.basename(s.physicalPath)};}) || [{path:path.resolve(intent.sourcePath || ''),id:null,name:validateName(intent.name || intent.source?.subdir?.split('/').at(-1) || path.basename(intent.sourcePath || ''))}];
        if (sourceSkills.length===0) fail('EMPTY_PLAN','请选择技能。');
        for (const skill of sourceSkills) {
          if (intent.kind === 'import') {
            const manifest=await this.sourceManifest(skill.path);
            const library=this.store.get('settings','main',{}).libraryPath || path.join(this.dataDir,'library');
            await add('install',skill.path,path.join(library,hashText(skill.path).slice(0,16),manifest.hash.slice(0,16),skill.name),{skillId:skill.id,tool:'library',scope:'library',source:intent.source || null});
          } else {
            if (!intent.targets?.length) fail('EMPTY_PLAN','请选择至少一个工具和范围。');
            for (const target of intent.targets) {
              const targetPath=this.targetFor(target,skill.name);
              if(await exists(targetPath)) fail('TARGET_CONFLICT','安装位置已存在；请检查来源或使用已登记安装的更新功能。',{path:targetPath});
              await add('install',skill.path,targetPath,{skillId:skill.id,tool:target.tool,scope:target.scope,source:intent.source||null});
            }
          }
        }
      } else if (['remove','update'].includes(intent.kind)) {
        const deployment=this.store.get('deployments',intent.deploymentId);
        if (!deployment) fail('NOT_MANAGED','仅能移除或更新本程序登记的安装。');
        const current=await fingerprint(deployment.targetPath);
        if(!current.exists) fail('NOT_FOUND','安装目录已不存在，请刷新索引。');
        if(current.hash!==deployment.baselineHash && !intent.force) fail('LOCAL_MODIFIED','本地内容已修改；请选择“备份当前内容后继续”。');
        if(intent.kind==='update' && !deployment.baselineHash) fail('LOCAL_MODIFIED','安装缺少可靠基线，不能覆盖。');
        await add(intent.kind,intent.kind==='update'?intent.sourcePath:null,deployment.targetPath,{...deployment,id:randomUUID(),deploymentId:deployment.id,source:intent.source||deployment.source});
      } else if(intent.kind==='restore') {
        const op=this.store.get('operations',intent.operationId);
        if(!op) fail('NOT_FOUND','原操作不存在。');
        for(const step of op.steps.filter(s=>['completed','committed'].includes(s.status))) {
          const current=await fingerprint(step.targetPath);
          if(current.hash!==step.afterHash || current.exists !== Boolean(step.afterHash)) {
            if(!intent.force) fail('LOCAL_MODIFIED','原操作之后目标已有改动；请另存当前内容后再恢复。',{path:step.targetPath});
          }
          if(step.before.exists && !step.snapshotPath) fail('RECOVERY_REQUIRED','原操作的恢复快照缺失。');
          await add('restore',step.before.exists?step.snapshotPath:null,step.targetPath,{tool:step.tool,scope:step.scope,restoreDeployments:step.previousDeployments,restoresOperationId:op.id,restoresStepId:step.id,restoreSnapshotHash:step.before.exists?step.beforeHash:null});
        }
      } else fail('INVALID_OPERATION','不支持的操作类型。');
    } catch(e) { plan.blockers.push({code:e.code||'PLAN_ERROR',message:e.message,details:e.details||{}}); }
    if(!plan.steps.length && !plan.blockers.length) plan.blockers.push({code:'EMPTY_PLAN',message:'没有可以执行的变更。'});
    if(plan.steps.some(s=>s.tools.length>1)) plan.warnings.push('目标可能被多个工具发现，预览中的影响范围包括所有已知工具。');
    plan.warnings.push('完成文件复制后，需要在目标工具中刷新或开启新会话；本程序不宣称技能已加载。');
    plan.summary = `${({install:'安装',import:'导入集中库',remove:'移除此安装',update:'更新',restore:'恢复'})[intent.kind]||'操作'} · ${plan.steps.length} 个目标`;
    plan.digest=hashText(JSON.stringify(plan)); this.store.put('plans',plan.id,plan); return plan;
  }
  execute(planId,digest) {
    const task=this.queue.then(()=>this.executeLocked(planId,digest));
    this.queue=task.catch(()=>{}); return task;
  }
  async validateStep(step) {
    await this.assertWritable(step.targetPath); await assertAnchors(step.parentAnchors);
    if(!equalFingerprint(await fingerprint(step.targetPath),step.before)) fail('PLAN_STALE','目标内容或目录身份在预览后发生变化，请重新预览。',{path:step.targetPath});
    // 包指纹排除 .git，因此每次切换前都必须单独复查新增的版本库资料。
    if(step.before.exists && await containsVcs(step.targetPath)) fail('TARGET_REPOSITORY','目标在预览后包含 Git 工作区，已保留所有原文件，请重新处理。');
    if(step.action==='restore') {
      const operation=this.store.get('operations',step.restoresOperationId);
      const original=operation?.steps.find(item=>item.id===step.restoresStepId);
      const expected=original?.before.exists?original.beforeHash:null;
      if(!original || original.targetPath!==step.targetPath || expected!==step.restoreSnapshotHash || expected!==step.afterHash || (original.before.exists?original.snapshotPath:null)!==step.sourcePath)
        fail('PLAN_STALE','恢复计划与原操作记录不一致，请重新预览。');
    }
    if(step.sourcePath) {
      await assertAnchors(step.sourceAnchors);
      let source;
      try { source=await this.sourceManifest(step.sourcePath); }
      catch(error) {
        if(step.action==='restore') fail('SNAPSHOT_CORRUPT','恢复快照无法完整核验，已保留当前文件，请先检查快照。');
        throw error;
      }
      if(step.action==='restore' && (source.hash!==step.restoreSnapshotHash || await containsVcs(step.sourcePath)))
        fail('SNAPSHOT_CORRUPT','恢复快照在预览后发生变化，已保留当前文件并阻止恢复。');
      if(source.hash!==step.afterHash) fail('PLAN_STALE','来源内容在预览后发生变化，请重新预览。');
    }
  }
  async executeLocked(planId,digest) {
    const previous=this.store.get('operations',planId);
    if(previous) return previous;
    const plan=this.store.get('plans',planId);
    if(!plan || plan.digest!==digest) fail('PLAN_STALE','计划不存在或摘要不匹配。');
    if(plan.blockers.length) fail('PLAN_BLOCKED','计划仍有阻止执行的问题。');
    if(Date.now()-Date.parse(plan.createdAt)>30*60*1000) fail('PLAN_STALE','计划超过30分钟，请重新预览。');
    for(const step of plan.steps) await this.validateStep(step);
    const op={...plan,status:'running',steps:plan.steps.map(s=>({...s,status:'pending'}))};
    this.store.put('operations',op.id,op);
    for(let i=0;i<op.steps.length;i++) {
      const step=op.steps[i];
      this.onProgress({kind:'operation',message:`${plan.summary}：${path.basename(step.targetPath)}`,current:i,total:op.steps.length});
      try { await this.applyStep(op,step); }
      catch(e) {
        step.error={code:e.code||'WRITE_FAILED',message:e.message};
        step.status=['switching','committed'].includes(step.status)?'recovery-required':'failed';
        this.store.put('operations',op.id,op);
      }
    }
    op.status=op.steps.some(s=>s.status==='recovery-required')?'recovery-required':op.steps.every(s=>s.status==='completed')?'completed':'partial';
    op.completedAt=stamp(); this.store.put('operations',op.id,op); return op;
  }
  async applyStep(op,step) {
    await this.validateStep(step);
    const backupBase=path.join(this.dataDir,'backups',op.id,step.id);
    await fs.mkdir(backupBase,{recursive:true});
    if(step.before.exists) {
      step.snapshotPath=path.join(backupBase,'before');
      await fs.cp(step.targetPath,step.snapshotPath,{recursive:true,dereference:false,errorOnExist:true,force:false});
      const saved=await this.sourceManifest(step.snapshotPath);
      if(saved.hash!==step.beforeHash) fail('PLAN_STALE','快照与计划内容不同；保留原文件。');
    }
    if(step.sourcePath && step.action !== 'restore') {
      step.revisionPath=path.join(this.dataDir,'revisions',step.afterHash);
      if(!await exists(step.revisionPath)) {
        await fs.mkdir(path.dirname(step.revisionPath),{recursive:true});
        await fs.cp(step.sourcePath,step.revisionPath,{recursive:true,dereference:false,errorOnExist:true,force:false,filter:source=>path.basename(source)!=='.git'});
      }
      if((await this.sourceManifest(step.revisionPath)).hash!==step.afterHash) fail('REVISION_CORRUPT','基线快照校验失败，未切换目标。');
    }
    step.status='snapshotted'; this.store.put('operations',op.id,op);
    const parent=path.dirname(step.targetPath);
    await fs.mkdir(parent,{recursive:true});
    step.stagePath=path.join(parent,`.skill-manager-stage-${randomUUID()}`);
    step.retiredPath=path.join(parent,`.skill-manager-retired-${randomUUID()}`);
    if(step.sourcePath) {
      await fs.cp(step.sourcePath,step.stagePath,{recursive:true,dereference:false,errorOnExist:true,force:false,filter:source=>path.basename(source)!=='.git'});
      const staged=await this.sourceManifest(step.stagePath);
      if(staged.hash!==step.afterHash) fail('PLAN_STALE','复制时来源发生改变，未替换目标。');
    }
    await this.validateStep(step);
    step.status='switching'; this.store.put('operations',op.id,op);
    if(step.before.exists) await fs.rename(step.targetPath,step.retiredPath);
    if(step.sourcePath) await fs.rename(step.stagePath,step.targetPath);
    step.status='committed'; this.store.put('operations',op.id,op);
    const after=await fingerprint(step.targetPath);
    if(after.hash!==step.afterHash || after.exists!==Boolean(step.afterHash)) fail('RECOVERY_REQUIRED','切换后内容核验失败，已保留快照与现场。');
    this.commitMetadata(op,step);
    step.status='completed'; this.store.put('operations',op.id,op);
    try { await this.cleanupRetired(step); } catch(e) {step.cleanupWarning=e.message;this.store.put('operations',op.id,op);}
  }
  commitMetadata(op,step) {
    this.store.transaction(()=>{
      for(const d of this.deployments().filter(d=>d.targetPath===step.targetPath)) this.store.delete('deployments',d.id);
      if(step.action==='restore') {
        for(const d of step.restoreDeployments||[]) this.store.put('deployments',d.id,d);
      } else if(step.afterHash) {
        const id=step.deploymentId||hashText(`${step.tool}:${step.scope}:${step.targetPath}`).slice(0,24);
        this.store.put('deployments',id,{id,skillId:step.skillId,tool:step.tool,scope:step.scope,targetPath:step.targetPath,physicalTarget:step.physicalTarget,baselineHash:step.afterHash,baseline:step.manifest,revisionPath:step.revisionPath,source:step.source,operationId:op.id,installedAt:stamp()});
      }
    });
  }
  async cleanupRetired(step) {
    if(!step.retiredPath || !await exists(step.retiredPath)) return;
    // 仅删除本程序生成、同父目录、且仍与已备份内容一致的暂存对象。
    if(path.dirname(step.retiredPath)!==path.dirname(step.targetPath) || !path.basename(step.retiredPath).startsWith('.skill-manager-retired-')) return;
    await assertAnchors(step.parentAnchors);
    const current=await fingerprint(step.retiredPath);
    if(current.hash===step.beforeHash && current.complete && !current.link) {
      if(await containsVcs(step.retiredPath)) fail('TARGET_REPOSITORY','原目录现场新增了 Git 资料，已保留现场，未自动清理。');
      await fs.rm(step.retiredPath,{recursive:true});
    }
  }
  async recover() {
    const reports=[];
    for(const op of this.history().filter(o=>['running','recovery-required'].includes(o.status))) {
      for(const step of op.steps) {
        if(['completed','failed'].includes(step.status)) continue;
        try {
          await this.assertWritable(step.targetPath);
          await assertAnchors(step.parentAnchors);
          const current=await fingerprint(step.targetPath);
          if(current.hash===step.afterHash && current.exists===Boolean(step.afterHash) && ['switching','committed','recovery-required'].includes(step.status)) {
            this.commitMetadata(op,step); step.status='completed'; await this.cleanupRetired(step);
          } else if(equalFingerprint(current,step.before)) { step.status='failed'; step.error={code:'INTERRUPTED',message:'中断发生在切换之前；原文件保持可用，请重新预览。'}; }
          else if(!current.exists && step.retiredPath && await exists(step.retiredPath)) {
            const old=await fingerprint(step.retiredPath);
            if(old.hash!==step.beforeHash || old.link) fail('RECOVERY_REQUIRED','原文件现场已改变，需要人工核对。');
            await fs.rename(step.retiredPath,step.targetPath); step.status='failed'; step.error={code:'INTERRUPTED',message:'已从同卷现场恢复原文件。'};
          } else { step.status='recovery-required'; step.error={code:'RECOVERY_REQUIRED',message:'现场与前后指纹均不符，已保留文件和快照。'}; }
        } catch(e) { step.status='recovery-required'; step.error={code:e.code||'RECOVERY_REQUIRED',message:e.message}; }
      }
      op.status=op.steps.some(s=>s.status==='recovery-required')?'recovery-required':op.steps.every(s=>s.status==='completed')?'completed':'partial';
      this.store.put('operations',op.id,op); reports.push(op);
    }
    return reports;
  }
}

export function compareVersions(baseline,local,remote) {
  if(!baseline?.complete || !local?.complete || !remote?.complete) return {status:'unknown',localChanged:null,remoteChanged:null,files:[]};
  const localChanged=baseline.hash!==local.hash, remoteChanged=baseline.hash!==remote.hash;
  const status=local.hash===remote.hash?(localChanged?'aligned':'current'):localChanged?(remoteChanged?'both-changed':'local-changed'):'available';
  const maps=[baseline,local,remote].map(m=>new Map(m.files.map(f=>[f.path,f])));
  const names=[...new Set(maps.flatMap(m=>[...m.keys()]))].sort();
  const signature=f=>f?`${f.type}:${f.hash}:${f.target||''}`:null;
  const files=names.filter(n=>new Set(maps.map(m=>signature(m.get(n)))).size>1).map(n=>({path:n,status:!maps[2].has(n)?'deleted':!maps[0].has(n)?'added':'modified',baseline:maps[0].get(n)||null,local:maps[1].get(n)||null,remote:maps[2].get(n)||null}));
  return {status,localChanged,remoteChanged,files};
}
