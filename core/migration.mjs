import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const allowedFields = new Set(['id','name','description','category','path','local_path','install_path','source_url','repository_url','skill_path','display_name','alias','tool','enabled']);
export async function previewMigration(inputPath) {
  const stats=await fs.stat(inputPath);
  const inputs=stats.isDirectory()?['skills-manager.db','skills_inventory.json','session_snapshot.json','cleanup_receipt.json'].map(n=>path.join(inputPath,n)):[inputPath];
  const report={id:'',createdAt:new Date().toISOString(),files:[],records:[],warnings:[],summary:{historical:0,matched:0},readOnly:true};
  for(const file of inputs) {
    try {
      if(/\.(db|sqlite|sqlite3)$/i.test(file)) {
        // 同一只读事务内查询所有表，SQLite 自动包含 WAL 的一致视图。
        const db=new DatabaseSync(file,{readOnly:true});
        try {
          db.exec('BEGIN');
          const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
          for(const table of ['skills','discovered_skills','skill_targets']) {
            if(!tables.includes(table)) continue;
            const rows=db.prepare(`SELECT * FROM "${table}" LIMIT 10001`).all();
            if(rows.length>10000) report.warnings.push(`${table} 超过10000条，只预览前10000条。`);
            for(const row of rows.slice(0,10000)) {
              const data=Object.fromEntries(Object.entries(row).filter(([k])=>allowedFields.has(k)).map(([k,v])=>[k,typeof v==='bigint'?String(v):v]));
              report.records.push({kind:'legacy',file,table,data,unknownFields:Object.keys(row).filter(k=>!allowedFields.has(k))});
            }
          }
          db.exec('COMMIT');
          report.files.push({path:file,kind:'sqlite',hash:sha(JSON.stringify(report.records.filter(r=>r.file===file))),method:'只读 SQLite 一致事务（包含 WAL）'});
        } finally {db.close();}
      } else if(/\.json$/i.test(file)) {
        if((await fs.stat(file)).size>50*1024*1024) fail('IMPORT_LIMIT','迁移清单超过50MB，请先拆分。');
        const raw=await fs.readFile(file); const data=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));
        const list=Array.isArray(data)?data:(data.skills||data.items||data.entries||data.edits||[]);
        for(const entry of Array.isArray(list)?list.slice(0,10000):[]) {
          report.records.push({kind:path.basename(file)==='session_snapshot.json'?'historical-session':'inventory',file,data:{name:entry.name,path:entry.path||entry.primary_path||entry.paths?.[0],alias:entry.alias,category:entry.category},capturedAt:data.captured_at||data.generated_at||null});
        }
        report.files.push({path:file,kind:'json',hash:sha(raw),method:'历史证据，不表示当前会话已加载'});
      } else fail('INVALID_IMPORT','请选择旧数据库或 JSON 清单。');
    } catch(e) {
      if(e.code!=='ENOENT') report.warnings.push(`${path.basename(file)}：${e.message}`);
    }
  }
  if(!report.files.length) fail('INVALID_IMPORT','没有可读取的旧数据库或历史清单。');
  report.summary.historical=report.records.length;
  report.id=sha(JSON.stringify(report.files));
  return report;
}

export async function importMigration(report,store) {
  if(store.get('migrations',report.id)) return {...store.get('migrations',report.id),alreadyImported:true};
  const byReal=new Map();
  for(const s of store.all('skills')) byReal.set(await fs.realpath(s.physicalPath).catch(()=>s.physicalPath),s);
  let matched=0;
  for(const record of report.records) {
    const entry={...record.data,path:record.data.path||record.data.local_path||record.data.install_path||record.data.skill_path};
    if(!entry.path || typeof entry.path!=='string') continue;
    const dir=/skill\.md$/i.test(entry.path)?path.dirname(entry.path):entry.path;
    const real=await fs.realpath(dir).catch(()=>null); const skill=real?byReal.get(real):null;
    if(!skill) continue;
    matched++;
    // 历史会话证据只保留时间和出处；不升级成当前加载状态。
    if(record.kind==='historical-session') store.put('observations',sha(`${report.id}:${skill.id}`),{skillId:skill.id,dimension:'historical-session',capturedAt:record.capturedAt,source:record.file,value:'expired'});
    else {
      const meta=store.get('metadata',skill.id,{});
      store.put('metadata',skill.id,{...meta,alias:meta.alias||entry.alias||entry.display_name||'',tags:meta.tags||[entry.category].filter(Boolean)});
    }
  }
  const result={...report,summary:{...report.summary,matched},importedAt:new Date().toISOString()};
  store.put('migrations',report.id,result); return result;
}
