import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagerService } from '../core/service.mjs';

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'skill-operation-result-')));
  const identity = await fs.stat(root, {bigint:true});
  const sourcePath = path.join(root, 'source');
  await fs.mkdir(sourcePath);
  await fs.writeFile(path.join(sourcePath, 'SKILL.md'), '---\nname: result-test\ndescription: 操作结果故障测试\n---\n原始正文\n');
  const manager = new ManagerService({dataDir:path.join(root,'data'),home:path.join(root,'home')});
  manager.store.put('settings','main',{libraryPath:path.join(root,'library')});
  t.after(async () => {
    if(manager.shutdown) await manager.shutdown(); else manager.close();
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), temporaryRoot);
    const current = await fs.stat(root, {bigint:true});
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    await fs.rm(root, {recursive:true,force:true});
  });
  const plan = await manager.call('operations.plan',{kind:'import',sourcePath,name:'result-test'});
  assert.deepEqual(plan.blockers, []);
  return {manager,plan,execute:()=>manager.call('operations.execute',{planId:plan.id,digest:plan.digest})};
}

test('文件完成后扫描失败仍返回同一个成功操作，重复确认不再次写文件', async t => {
  const f = await fixture(t);
  let writes = 0;
  const applyStep = f.manager.engine.applyStep.bind(f.manager.engine);
  f.manager.engine.applyStep = (...args) => {writes++; return applyStep(...args);};
  f.manager.scan = async () => {throw Object.assign(new Error('模拟索引读取失败'),{code:'SCAN_FAILED'});};
  const result = await f.execute();
  assert.equal(result.id, f.plan.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.operation.id, f.plan.id);
  assert.equal(result.operation.status, 'completed');
  assert.equal(result.indexRefresh.status, 'failed');
  assert.equal(result.indexRefresh.stage, 'scan');
  assert.equal(result.indexRefresh.error.code, 'SCAN_FAILED');
  assert.match(await fs.readFile(path.join(result.steps[0].targetPath,'SKILL.md'),'utf8'), /原始正文/);
  const repeated = await f.execute();
  assert.equal(repeated.id, result.id); assert.equal(writes, 1);
  assert.equal((await f.manager.call('operations.status',{id:result.id})).indexRefresh.status, 'failed');
  f.manager.scan = async () => ({});
  const refreshed = await f.manager.call('operations.refresh',{id:result.id});
  assert.equal(refreshed.operation.status, 'completed');
  assert.equal(refreshed.indexRefresh.status, 'completed');
  assert.equal(writes, 1);
});

test('扫描目录登记失败不掩盖文件结果，仅刷新可修复元数据且不重写文件', async t => {
  const f = await fixture(t);
  const put = f.manager.store.put.bind(f.manager.store);
  let failMetadata = true, scans = 0;
  f.manager.store.put = (collection,...args) => {
    if(collection === 'roots' && failMetadata) throw Object.assign(new Error('模拟目录登记失败'),{code:'METADATA_FAILED'});
    return put(collection,...args);
  };
  f.manager.scan = async () => {scans++; return {};};
  const result = await f.execute();
  assert.equal(result.operation.status, 'completed');
  assert.equal(result.indexRefresh.status, 'failed');
  assert.equal(result.indexRefresh.stage, 'metadata');
  assert.equal(scans, 0);
  assert.equal(f.manager.store.all('roots').length, 0);
  const targetFile = path.join(result.steps[0].targetPath,'SKILL.md');
  await fs.writeFile(targetFile,'用户后续修改');
  failMetadata = false;
  f.manager.store.put('settings','main',{libraryPath:path.join(path.dirname(targetFile),'different-library')});
  const refreshed = await f.manager.call('operations.refresh',{id:result.id});
  assert.equal(refreshed.indexRefresh.status, 'completed');
  assert.equal(f.manager.store.all('roots').length, 1);
  assert.equal(f.manager.store.all('roots')[0].path,path.dirname(result.steps[0].targetPath));
  assert.equal(await fs.readFile(targetFile,'utf8'), '用户后续修改');
  assert.equal(scans, 1);
});

test('部分完成的权威操作状态不被成功扫描改成全部完成', async t => {
  const f = await fixture(t);
  const operation = {id:f.plan.id,status:'partial',steps:[{id:'failed-step',status:'failed',error:{code:'WRITE_FAILED',message:'写入失败'}}]};
  f.manager.engine.execute = async () => operation;
  f.manager.scan = async () => ({});
  const result = await f.execute();
  assert.equal(result.status,'partial');
  assert.equal(result.operation.status,'partial');
  assert.equal(result.indexRefresh.status,'completed');
  assert.equal(result.operation.steps[0].error.code,'WRITE_FAILED');
});

test('已进入退出流程时保留文件结果并登记下次刷新，不启动扫描', async t => {
  const f = await fixture(t);
  const execute = f.manager.engine.execute.bind(f.manager.engine);
  f.manager.engine.execute = async (...args) => {
    const result = await execute(...args);
    f.manager.lifecycle ||= {};
    f.manager.lifecycle.closing = true;
    return result;
  };
  f.manager.scan = async () => {assert.fail('退出中不能启动新扫描');};
  const result = await f.execute();
  assert.equal(result.operation.status,'completed');
  assert.equal(result.indexRefresh.status,'skipped');
  assert.equal(result.indexRefresh.pending,true);
  assert.equal(f.manager.store.get('operations',result.id).indexRefresh.pending,true);
});

test('文件前置校验失败仍作为执行错误返回', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.call('operations.execute',{planId:f.plan.id,digest:'wrong'}),{code:'PLAN_STALE'});
  assert.equal(f.manager.engine.history().length,0);
});

test('并发重复确认不能用错误摘要复用正在执行的计划', async t => {
  const f = await fixture(t);
  let release, entered;
  const hold = new Promise(resolve => {release = resolve;});
  const started = new Promise(resolve => {entered = resolve;});
  const execute = f.manager.engine.execute.bind(f.manager.engine);
  f.manager.engine.execute = async (...args) => {entered(); await hold; return execute(...args);};
  f.manager.scan = async () => ({});
  const pending = f.execute();
  await started;
  try {
    await assert.rejects(f.manager.call('operations.execute',{planId:f.plan.id,digest:'wrong'}),{code:'PLAN_STALE'});
  } finally {release();}
  assert.equal((await pending).operation.status,'completed');
});

test('仅刷新拒绝仍在运行的操作，不能覆盖事务日志', async t => {
  const f = await fixture(t);
  const running = {...f.plan,status:'running'};
  f.manager.store.put('operations',f.plan.id,running);
  f.manager.scan = async () => {assert.fail('运行中的操作不能开始刷新');};
  await assert.rejects(f.manager.call('operations.refresh',{id:f.plan.id}),{code:'OPERATION_RUNNING'});
  assert.deepEqual(f.manager.store.get('operations',f.plan.id),running);
});

test('刷新结果日志保存失败仍返回文件完成状态及操作编号', async t => {
  const f = await fixture(t);
  const put = f.manager.store.put.bind(f.manager.store);
  f.manager.store.put = (collection,id,value) => {
    if(collection === 'operations' && value.indexRefresh?.status === 'completed') throw Object.assign(new Error('模拟结果日志保存失败'),{code:'JOURNAL_FAILED'});
    return put(collection,id,value);
  };
  f.manager.scan = async () => ({});
  const result = await f.execute();
  assert.equal(result.operation.id,f.plan.id);
  assert.equal(result.operation.status,'completed');
  assert.equal(result.indexRefresh.status,'failed');
  assert.equal(result.indexRefresh.stage,'record');
  assert.equal(result.indexRefresh.recordError.code,'JOURNAL_FAILED');
  assert.equal(f.manager.store.get('operations',f.plan.id).status,'completed');
});

test('执行后的自动刷新与同一操作的手动刷新共用一次扫描', async t => {
  const f = await fixture(t);
  let release, entered, scans = 0;
  const hold = new Promise(resolve => {release = resolve;});
  const started = new Promise(resolve => {entered = resolve;});
  f.manager.scan = async () => {scans++; entered(); await hold; return {};};
  const executing = f.execute();
  await started;
  const refreshing = f.manager.call('operations.refresh',{id:f.plan.id});
  let results;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scans,1);
  } finally {release(); results = await Promise.all([executing,refreshing]);}
  assert.equal(results[0].operation.id,f.plan.id);
  assert.deepEqual(results[0],results[1]);
  assert.equal(results[0].indexRefresh.status,'completed');
});

test('刷新结果回写只追加索引状态，保留扫描期间更新的恢复日志', async t => {
  const f = await fixture(t);
  let release, entered;
  const hold = new Promise(resolve => {release = resolve;});
  const started = new Promise(resolve => {entered = resolve;});
  f.manager.scan = async () => {entered(); await hold; return {};};
  const executing = f.execute();
  await started;
  const latest = {...f.manager.store.get('operations',f.plan.id),status:'restored',restoredBy:'restore-fixture'};
  latest.steps = latest.steps.map(step => ({...step,recoveryEvidence:'已重新核验'}));
  f.manager.store.put('operations',f.plan.id,latest);
  release();
  const result = await executing;
  const saved = f.manager.store.get('operations',f.plan.id);
  assert.equal(saved.status,'restored');
  assert.equal(saved.restoredBy,'restore-fixture');
  assert.equal(saved.steps[0].recoveryEvidence,'已重新核验');
  assert.equal(result.operation.status,'restored');
  assert.equal(result.operation.restoredBy,'restore-fixture');
  assert.equal(result.indexRefresh.status,'completed');
});

test('索引扫描失败后取消目录登记，仅刷新不能重新登记已移除目录', async t => {
  const f = await fixture(t);
  f.manager.scan = async () => {throw new Error('模拟扫描失败');};
  const result = await f.execute();
  const [root] = f.manager.store.all('roots');
  assert.ok(root);
  assert.equal(result.indexRefresh.metadataCompleted,true);
  await f.manager.call('roots.remove',{id:root.id});
  f.manager.scan = async () => ({});
  const refreshed = await f.manager.call('operations.refresh',{id:result.id});
  assert.equal(refreshed.indexRefresh.status,'completed');
  assert.equal(f.manager.store.all('roots').length,0);
});

test('元数据登记失败后取消目录登记，重试明确记录跳过且不恢复目录', async t => {
  const f = await fixture(t);
  const { hashText } = await import('../core/operations.mjs');
  const library = f.manager.store.get('settings','main').libraryPath;
  const root = {id:hashText(library).slice(0,20),path:library,kind:'library',scope:'library'};
  f.manager.store.put('roots',root.id,root);
  const put = f.manager.store.put.bind(f.manager.store);
  f.manager.store.put = (collection,...args) => {
    if(collection === 'roots') throw new Error('模拟元数据登记失败');
    return put(collection,...args);
  };
  const result = await f.execute();
  assert.equal(result.indexRefresh.stage,'metadata');
  await f.manager.call('roots.remove',{id:root.id});
  f.manager.store.put = put;
  f.manager.scan = async () => ({});
  const refreshed = await f.manager.call('operations.refresh',{id:result.id});
  assert.equal(f.manager.store.all('roots').length,0);
  assert.equal(refreshed.indexRefresh.status,'completed');
  assert.equal(refreshed.indexRefresh.metadataSkipped[0].reason,'root-removed');
  assert.equal(refreshed.indexRefresh.metadataSkipped[0].stepId,result.steps[0].id);
  assert.match(refreshed.indexRefresh.metadataSkipped[0].message,/取消登记/);
});

test('项目安装的元数据失败后取消项目登记，重试不能复活项目扫描目录', async t => {
  const f = await fixture(t);
  const projectPath = path.join(f.manager.home,'project');
  await fs.mkdir(projectPath,{recursive:true});
  const project = {id:'removed-project',path:projectPath,name:'测试项目'};
  f.manager.store.put('projects',project.id,project);
  const plan = await f.manager.call('operations.plan',{kind:'install',sourcePath:f.plan.steps[0].sourcePath,name:'project-result',targets:[{tool:'codex',scope:projectPath}]});
  assert.deepEqual(plan.blockers,[]);
  const put = f.manager.store.put.bind(f.manager.store);
  f.manager.store.put = (collection,...args) => {
    if(collection === 'roots') throw new Error('模拟项目目录登记失败');
    return put(collection,...args);
  };
  const result = await f.manager.call('operations.execute',{planId:plan.id,digest:plan.digest});
  assert.equal(result.indexRefresh.stage,'metadata');
  await f.manager.call('projects.remove',{id:project.id});
  f.manager.store.put = put;
  f.manager.scan = async () => ({});
  const refreshed = await f.manager.call('operations.refresh',{id:result.id});
  assert.equal(f.manager.store.all('roots').length,0);
  assert.equal(refreshed.indexRefresh.status,'completed');
  assert.equal(refreshed.indexRefresh.metadataSkipped[0].reason,'project-removed');
  assert.equal(f.manager.store.get('projects',project.id),null);
  assert.match(await fs.readFile(path.join(result.steps[0].targetPath,'SKILL.md'),'utf8'),/原始正文/);
});
