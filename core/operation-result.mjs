import path from 'node:path';
import { hashText, inside } from './operations.mjs';
import { fail, serializeError } from './errors.mjs';

const pendingByManager = new WeakMap();
const refreshesByManager = new WeakMap();

function response(record, indexRefresh = record.indexRefresh) {
  const {indexRefresh: previous, ...operation} = record;
  // 顶层保留旧版调用者使用的 id/status；文件事务结果始终独立于索引结果。
  return {...operation,operation,indexRefresh};
}

function saveRefresh(manager, operation, indexRefresh) {
  try {
    if(operation.id) {
      // 扫描期间可能已有恢复等后续记录，只在最新日志上追加刷新状态。
      operation = manager.store.get('operations',operation.id) || operation;
      manager.store.put('operations',operation.id,{...operation,indexRefresh});
    }
  } catch(error) {
    // 索引日志落库失败也不能把已经完成的文件事务改写成执行失败。
    indexRefresh = {...indexRefresh,status:'failed',pending:true,stage:indexRefresh.stage || 'record',recordError:serializeError(error)};
  }
  return response(operation,indexRefresh);
}

function registrationDirectory(manager, step) {
  const library = manager.store.get('settings','main',{}).libraryPath || path.join(manager.dataDir,'library');
  // 集中库设置可能在重试前改变，仍以该操作真正写入的位置登记索引。
  return step.tool === 'library' && inside(library,step.targetPath) ? library : path.dirname(step.targetPath);
}

// 与取消登记一起提交，精确绑定当时已有的操作；新的安装计划不受旧记录影响。
export function recordRegistrationRemoval(manager, removal) {
  for(const operation of manager.store.all('operations')) {
    for(const step of operation.steps || []) {
      if(!step.targetPath) continue;
      const matches = removal.scope !== undefined ? step.scope === removal.scope : removal.path ? inside(removal.path,step.targetPath) : hashText(registrationDirectory(manager,step)).slice(0,20) === removal.id;
      if(matches) manager.store.put('index-registration-removals',`${operation.id}:${step.id}`,{
        operationId:operation.id,stepId:step.id,path:removal.path || registrationDirectory(manager,step),
        reason:removal.scope !== undefined ? 'project-removed' : 'root-removed',removedAt:new Date().toISOString(),
        message:removal.scope !== undefined ? '该项目已取消登记，本次仅刷新不会重新登记其扫描目录。' : '该目录已取消登记，本次仅刷新不会将其重新加入扫描。',
      });
    }
  }
}

async function refresh(manager, record) {
  const {indexRefresh: previous, ...operation} = record;
  let stage = 'metadata';
  let metadataCompleted = previous?.metadataCompleted === true;
  const metadataSkipped = [...(previous?.metadataSkipped || [])];
  const state = value => ({...value,metadataCompleted,metadataSkipped,checkedAt:new Date().toISOString()});
  try {
    if(!metadataCompleted) {
      manager.store.transaction(() => {
        for(const step of operation.steps.filter(item => item.status === 'completed')) {
          const removal = manager.store.get('index-registration-removals',`${operation.id}:${step.id}`);
          if(removal) {
            if(!metadataSkipped.some(item => item.stepId === step.id)) metadataSkipped.push(removal);
          } else {
            const directory = registrationDirectory(manager,step);
            const id = hashText(directory).slice(0,20);
            manager.store.put('roots',id,{...manager.store.get('roots',id,{}),id,path:directory,kind:step.tool === 'library' ? 'library' : 'active',tools:step.tools,scope:step.scope,enabled:true});
          }
          for(const update of manager.store.all('updates')) {
            if(update.targetPath === step.targetPath) manager.store.put('updates',update.id,{...update,needsRecheck:true});
          }
        }
        // 登记与完成标志原子提交，扫描失败或重启后仅重试扫描。
        if(operation.id) manager.store.put('operations',operation.id,{
          ...(manager.store.get('operations',operation.id) || operation),
          indexRefresh:{...state({status:'skipped',reason:'scan-pending',pending:true}),metadataCompleted:true},
        });
      });
      metadataCompleted = true;
    }
    const deferred = () => saveRefresh(manager,operation,state({status:'skipped',pending:true,reason:'shutdown',message:'文件结果已保存，退出后请在下次打开时刷新索引。'}));
    if(manager.lifecycle?.closing) return deferred();
    stage = 'scan';
    const pendingScan = manager.queryPromises.get('scan');
    if(pendingScan) await pendingScan.catch(() => {});
    if(manager.lifecycle?.closing) return deferred();
    await manager.scan();
    return saveRefresh(manager,operation,state({status:'completed',pending:false}));
  } catch(error) {
    return saveRefresh(manager,operation,state({status:'failed',pending:true,stage,error:serializeError(error)}));
  }
}

function refreshOnce(manager, record, refreshOnly) {
  let pending = refreshesByManager.get(manager);
  if(!pending) {pending = new Map(); refreshesByManager.set(manager,pending);}
  // 执行入口与手动刷新入口共享实际操作编号，不能并行刷新并覆盖彼此的结果。
  if(pending.has(record.id)) return pending.get(record.id);
  if(!refreshOnly && record.indexRefresh) return response(record);
  const task = refresh(manager,record).finally(() => {
    if(pending.get(record.id) === task) pending.delete(record.id);
  });
  pending.set(record.id,task);
  return task;
}

export function executeWithRefresh(manager, args, refreshOnly = false) {
  const id = refreshOnly ? args.id : args.planId;
  // 合并重复请求之前校验摘要，不能让错误确认借用正在执行的任务。
  if(!refreshOnly) {
    const savedPlan = manager.store.get('plans',id);
    if(savedPlan && savedPlan.digest !== args.digest) fail('PLAN_STALE','计划摘要不匹配，请重新预览。');
  }
  let pending = pendingByManager.get(manager);
  if(!pending) {pending = new Map(); pendingByManager.set(manager,pending);}
  const key = JSON.stringify([refreshOnly,id,args.digest]);
  if(pending.has(key)) return pending.get(key);
  const task = Promise.resolve().then(async () => {
    const record = refreshOnly ? manager.store.get('operations',id) : await manager.engine.execute(args.planId,args.digest);
    if(!record) fail('NOT_FOUND','操作记录不存在，请先查看操作历史。');
    if(refreshOnly && !['completed','partial','failed','recovery-required','restored'].includes(record.status)) fail('OPERATION_RUNNING','文件操作仍在执行，请等待结果后再刷新。');
    return refreshOnce(manager,record,refreshOnly);
  }).finally(() => {if(pending.get(key) === task) pending.delete(key);});
  pending.set(key,task);
  return task;
}
