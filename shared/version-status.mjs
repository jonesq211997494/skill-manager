// 版本状态仅来自完整包比较证据；“文件正常”与“版本最新”分别表达。
export const VERSION_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const labels = {
  current:'已是最新', available:'有更新', 'local-changed':'本地有修改', 'both-changed':'有更新 · 本地修改',
  'unknown-source':'来源未知', unchecked:'未检查', 'check-failed':'检查失败', stale:'待复查',
  pinned:'已固定版本', mixed:'部分状态未知', incomplete:'无法确认',
};
function clock(value) {const time=typeof value==='number'?value:Date.parse(value);return Number.isFinite(time)?time:0;}
function timeText(value) {return value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未检查';}
function hasSource(source) {
  try {const url=new URL(source?.url);return url.protocol==='https:'&&url.hostname==='github.com'&&!url.username&&!url.password;}catch{return false;}
}
function sameSource(a,b) {
  if(!a||!b)return false;
  const repository=a.repositoryId!=null&&b.repositoryId!=null?String(a.repositoryId)===String(b.repositoryId):a.url?.replace(/\/$/,'')===b.url?.replace(/\/$/,'');
  return repository && (a.subdir||'')===(b.subdir||'') && (a.ref||'')===(b.ref||'');
}
function state(status,description,extra={}) {return {...extra,status,label:labels[status]||labels.incomplete,description};}
function matches(item,{tool,scope}={}) {
  return (!tool||tool==='all'||(item.tools||[item.tool]).includes(tool)) && (!scope||scope==='all'||(item.scopes||[item.scope]).includes(scope));
}

export function buildVersionStates(skill,updates=[],{now=Date.now()}={}) {
  const aliases=skill.aliases||[];
  const tools=[...new Set([...(skill.tools||[]),...aliases.flatMap(a=>a.tools||[])])];
  const scopes=[...new Set(aliases.map(a=>a.scope).filter(Boolean))];
  if(!skill.deployments?.length) return [state(skill.pinned?'pinned':'unknown-source',skill.pinned?'已固定当前版本；固定并不表示这是最新版本。':'该技能尚未关联可核验的在线安装来源，不能仅凭名称或文件正常判断版本。',{tools,scopes,checkedAt:null,canCheck:false})];
  return skill.deployments.map(deployment=>{
    const physicalMatch=skill.physicalPath && [deployment.targetPath,deployment.physicalTarget].includes(skill.physicalPath);
    const relevantAliases=physicalMatch?aliases:aliases.filter(a=>[deployment.targetPath,deployment.physicalTarget].includes(a.path));
    const extra={deploymentId:deployment.id,tool:deployment.tool,scope:deployment.scope,
      tools:[...new Set([deployment.tool,...relevantAliases.flatMap(a=>a.tools||[])])],scopes:[...new Set([deployment.scope,...relevantAliases.map(a=>a.scope)])],checkedAt:null,canCheck:hasSource(deployment.source)&&!skill.pinned};
    if(skill.pinned)return state('pinned','已固定当前版本，更新检查会跳过此技能；固定并不表示最新。',extra);
    if(!hasSource(deployment.source))return state('unknown-source','此安装来自本地目录，尚未关联可核验的 GitHub 来源。',extra);
    const update=updates.find(item=>(item.deploymentId||item.id)===deployment.id);
    if(!update||update.status==='pinned')return state('unchecked','已关联在线来源；点击“检查更新”后判断是否与远端一致。',extra);
    const checkedAt=clock(update.checkedAt);
    extra.checkedAt=checkedAt?new Date(checkedAt).toISOString():null;
    if(!checkedAt||checkedAt>now+60000)return state('unchecked','上次检查缺少有效时间，请重新检查。',extra);
    if(!sameSource(deployment.source,update.checkedSource||update.source))return state('stale','安装来源或跟踪分支已变化，需要重新检查。',extra);
    if(update.targetPath && update.targetPath!==deployment.targetPath)return state('stale','安装位置已变化，需要重新检查。',extra);
    if(update.needsRecheck)return state('stale','安装文件或版本记录已变化，需要重新检查。',extra);
    if(now-checkedAt>VERSION_STATUS_TTL_MS)return state('stale',`上次检查于 ${timeText(checkedAt)}，已超过24小时，请重新检查。`,extra);
    if(update.status==='source-unavailable'||update.error)return state('check-failed',`上次检查未完成：${typeof update.error==='string'?update.error:update.error?.message||'来源不可用'}；不能据此认定最新。`,extra);
    if(['missing','incomplete','unreadable','inaccessible','broken-link'].includes(skill.health)||skill.manifest?.complete===false)return state('incomplete','本地文件缺失或完整包校验未完成，暂时不能确认版本。',extra);
    const observed=skill.manifest?.hash||skill.hash;
    if(observed&&update.localHash&&observed!==update.localHash)return state('stale','本地内容在上次检查后发生变化，请重新检查。',extra);
    const aligned=update.status==='aligned'&&update.localHash===update.remoteHash&&deployment.baselineHash===update.localHash;
    if(update.baselineHash!==deployment.baselineHash&&!aligned)return state('stale','安装基线已变化，旧检查结果不再适用。',extra);
    if(['current','aligned','available','local-changed','both-changed'].includes(update.status) && (!observed||!update.localHash||!update.remoteHash))return state('incomplete','缺少当前本地文件或远端完整包指纹，请重新检查。',extra);
    if(['current','aligned'].includes(update.status)) {
      if(!update.localHash||!update.remoteHash||update.localHash!==update.remoteHash)return state('incomplete','缺少可信的完整包一致性证据，不能显示为最新。',extra);
      return state('current',`完整技能包在 ${timeText(checkedAt)} 与远端一致；此结论以该次检查为准。`,extra);
    }
    if(update.status==='available')return state('available',`在 ${timeText(checkedAt)} 检测到远端更新，本地内容未偏离安装基线。`,extra);
    if(update.status==='both-changed')return state('both-changed',`在 ${timeText(checkedAt)} 检测到远端更新和本地修改，请查看差异后决定是否更新。`,extra);
    if(update.status==='local-changed')return state('local-changed',`在 ${timeText(checkedAt)} 未发现远端更新，但本地内容已修改。`,extra);
    return state('incomplete','缺少可靠安装基线或完整比较结果，暂时不能确认版本。',extra);
  });
}

export function summarizeVersionStates(states=[],{pinned=false,now=Date.now()}={}) {
  const normalized=states.map(item=>{
    const age=clock(item.checkedAt);
    return age&&now-age>VERSION_STATUS_TTL_MS&&!['unknown-source','pinned'].includes(item.status)?state('stale',`上次检查于 ${timeText(age)}，已超过24小时。`,item):item;
  });
  const extra={states:normalized,checkedAt:null,checkedCount:normalized.filter(s=>!!s.checkedAt).length,totalCount:normalized.length,canCheck:!pinned&&normalized.some(s=>s.canCheck)};
  const times=normalized.map(s=>clock(s.checkedAt)).filter(Boolean);extra.checkedAt=times.length?new Date(Math.min(...times)).toISOString():null;
  if(pinned)return state('pinned','已固定当前版本；固定并不表示最新。',extra);
  if(!normalized.length)return state('unknown-source','当前工具和范围没有可核验的在线来源。',extra);
  if(normalized.length===1)return {...normalized[0],...extra};
  let status;
  for(const candidate of ['both-changed','available','check-failed','local-changed'])if(normalized.some(s=>s.status===candidate)){status=candidate;break;}
  if(!status) {
    const unique=[...new Set(normalized.map(s=>s.status))];
    status=unique.length===1?unique[0]:normalized.some(s=>s.status==='incomplete')?'incomplete':normalized.some(s=>s.status==='stale')?'stale':normalized.some(s=>s.status==='unchecked')?'unchecked':'mixed';
  }
  const counts=new Map();for(const item of normalized)counts.set(item.label,(counts.get(item.label)||0)+1);
  return state(status,`${normalized.length} 个关联安装：${[...counts].map(([name,count])=>`${name} ${count} 项`).join('，')}。${extra.checkedAt?`最近可追溯检查时间：${timeText(extra.checkedAt)}。`:''}`,extra);
}

export function getSkillVersionStatus(skill,{tool,scope,now=Date.now()}={}) {
  const states=skill.versionStates||buildVersionStates(skill,[],{now});
  return summarizeVersionStates(states.filter(item=>matches(item,{tool,scope})),{pinned:skill.pinned,now});
}

export function versionStateMatches(item,filters={}) {return matches(item,filters);}

export { hasSource as hasVersionSource };
