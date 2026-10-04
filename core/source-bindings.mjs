import { randomUUID } from 'node:crypto';
import { buildManifest } from './scanner.mjs';
import { fingerprint, inside } from './operations.mjs';
import { fail } from './errors.mjs';
import { hasVersionSource } from '../shared/version-status.mjs';

function check(signal) {if(signal?.aborted)fail('CANCELLED','已取消来源比较。');}
export function compareSourceContent(local,remote) {
  if(!local?.complete||!remote?.complete)return {status:'unknown',localChanged:null,remoteChanged:null,files:[]};
  const left=new Map(local.files.map(f=>[f.path,f])),right=new Map(remote.files.map(f=>[f.path,f]));
  const signature=f=>f?`${f.type}:${f.hash||''}:${f.target||''}`:null;
  const files=[...new Set([...left.keys(),...right.keys()])].sort().filter(name=>signature(left.get(name))!==signature(right.get(name))).map(name=>({path:name,status:!left.has(name)?'added':!right.has(name)?'deleted':'modified',local:left.get(name)||null,remote:right.get(name)||null,baseline:null}));
  return {status:local.hash===remote.hash?'current':'different',localChanged:null,remoteChanged:null,files};
}

// 来源关联仅登记比较关系，与具有文件写入权限的 deployment 分开保存。
export class SourceBindings {
  constructor({store,sources,dataDir,getSkill,progress=()=>{}}) {Object.assign(this,{store,sources,dataDir,getSkill,progress});}
  skill(id) {const skill=this.getSkill(id);if(!skill)fail('NOT_FOUND','技能已不在当前扫描范围，请刷新后重试。');return skill;}
  mayBind(skill) {if(skill.deployments?.some(d=>hasVersionSource(d.source)))fail('SOURCE_ALREADY_MANAGED','此技能已有受管理安装来源，请使用现有来源检查更新。');}
  async inspect(id,url,{ref,signal}={}) {
    this.mayBind(this.skill(id));check(signal);return this.sources.inspect(url,{ref,signal});
  }
  async preview(id,candidate,{signal}={}) {
    const skill=this.skill(id);this.mayBind(skill);check(signal);
    this.progress({kind:'download',message:'正在核验本地技能与所选在线来源…'});
    const local=await fingerprint(skill.physicalPath,{signal});check(signal);
    if(!local.exists||local.link||!local.complete)fail('INCOMPLETE_SCAN','当前本地技能包无法完整核验，暂时不能关联来源。');
    const download=await this.sources.download(candidate,{signal,onProgress:event=>this.progress({kind:'download',message:'正在下载来源比较内容…',...event})});
    check(signal);
    if(!inside(this.dataDir,download.path))fail('INVALID_PATH','来源暂存位置不在应用数据目录内。');
    const remote=await buildManifest(download.path,{signal});check(signal);
    if(!remote.complete)fail('INCOMPLETE_SCAN','远端技能包校验不完整，不能保存关联。');
    const comparison=compareSourceContent(local.manifest,remote);
    const preview={id:randomUUID(),skillId:id,name:skill.name,physicalPath:skill.physicalPath,identity:local.identity,
      source:download.source,remotePath:download.path,localHash:local.hash,remoteHash:remote.hash,remoteManifest:remote,
      identical:comparison.status==='current',files:comparison.files,checkedAt:new Date().toISOString(),
      warnings:[comparison.status==='current'?'当前完整技能包与所选来源一致。':'当前内容与来源不同；可能是本地修改或不同版本，不能直接认定为有更新。','只保存来源关联和比较证据，不移动、覆盖或纳管原文件。']};
    this.store.put('source-previews',preview.id,preview);return preview;
  }
  async bind(previewId) {
    const preview=this.store.get('source-previews',previewId);if(!preview)fail('NOT_FOUND','来源预览不存在，请重新选择来源。');
    if(Date.now()-Date.parse(preview.checkedAt)>30*60*1000)fail('PLAN_STALE','来源预览已超过30分钟，请重新比较。');
    const skill=this.skill(preview.skillId);this.mayBind(skill);
    if(skill.physicalPath!==preview.physicalPath)fail('PLAN_STALE','技能位置在预览后发生变化，请重新比较。');
    const local=await fingerprint(skill.physicalPath);
    if(!local.complete||local.hash!==preview.localHash||JSON.stringify(local.identity)!==JSON.stringify(preview.identity))fail('PLAN_STALE','本地技能在预览后发生变化，请重新比较；原文件未修改。');
    if(!inside(this.dataDir,preview.remotePath))fail('INVALID_PATH','来源预览位置无效。');
    const remote=await buildManifest(preview.remotePath);
    if(!remote.complete||remote.hash!==preview.remoteHash)fail('PLAN_STALE','来源预览内容已经变化，请重新比较。');
    const currentSkill=this.skill(preview.skillId);this.mayBind(currentSkill);
    if(currentSkill.physicalPath!==preview.physicalPath)fail('PLAN_STALE','技能位置或扫描登记已经变化，请重新比较。');
    const linkedAt=new Date().toISOString();
    const binding={id:`source:${skill.id}`,skillId:skill.id,physicalPath:skill.physicalPath,trackingOnly:true,
      source:preview.source,linkedAt,baseline:preview.identical?remote:null,baselineHash:preview.identical?remote.hash:null,
      revisionPath:preview.identical?preview.remotePath:null};
    const update={id:binding.id,bindingId:binding.id,skillId:skill.id,trackingOnly:true,name:skill.name,targetPath:skill.physicalPath,
      tool:skill.tools?.[0]||'external',scope:skill.scope||'user',source:binding.source,checkedSource:binding.source,checkedAt:linkedAt,
      baselineHash:binding.baselineHash,localHash:local.hash,remoteHash:remote.hash,remotePath:preview.remotePath,...compareSourceContent(local.manifest,remote)};
    this.store.transaction(()=>{
      this.store.put('source-bindings',skill.id,binding);
      this.store.put('updates',binding.id,update);
      this.store.put('skills',skill.id,{...this.store.get('skills',skill.id),manifest:local.manifest,hash:local.hash});
      this.store.delete('source-previews',previewId);
    });
    return this.skill(skill.id);
  }
  unbind(id) {
    this.skill(id);const binding=this.store.get('source-bindings',id);
    this.store.transaction(()=>{this.store.delete('source-bindings',id);if(binding)this.store.delete('updates',binding.id);});
    return this.skill(id);
  }
}
