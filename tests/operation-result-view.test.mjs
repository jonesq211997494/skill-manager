import test from 'node:test';
import assert from 'node:assert/strict';
import { retainOperationResult, operationResultMessage } from '../shared/operation-result.mjs';

const completed = {id:'operation-fixture',status:'completed',operation:{id:'operation-fixture',status:'completed',steps:[]},indexRefresh:{status:'completed'}};

test('前端先保存文件结果，bootstrap 失败仍保留同一个成功操作', async () => {
  const calls = [];
  const result = await retainOperationResult(completed,value => {calls.push(value.operation.id);},async () => {
    assert.deepEqual(calls,['operation-fixture']);
    throw new Error('模拟界面读取失败');
  });
  assert.equal(result.operation.id,completed.operation.id);
  assert.equal(result.operation.status,'completed');
  assert.equal(result.indexRefresh.status,'completed');
  assert.equal(result.viewRefresh.status,'failed');
  assert.equal(result.viewRefresh.error.message,'模拟界面读取失败');
  assert.match(operationResultMessage(result),/文件操作已完成/);
  assert.match(operationResultMessage(result),/界面数据读取失败/);
});

test('前端分别描述文件部分完成、索引刷新失败和退出延后刷新', async () => {
  const refreshed = await retainOperationResult(completed,() => {},async () => {});
  assert.equal(refreshed.viewRefresh.status,'completed');
  assert.match(operationResultMessage({...completed,operation:{...completed.operation,status:'partial'},indexRefresh:{status:'failed'}}),/文件操作部分完成/);
  assert.match(operationResultMessage({...completed,indexRefresh:{status:'failed'}}),/文件操作已完成.*索引刷新失败/);
  assert.match(operationResultMessage({...completed,indexRefresh:{status:'skipped'}}),/下次.*刷新/);
});

test('已恢复是成功文件状态，提示已恢复且使用成功样式', async () => {
  const { operationResultTone } = await import('../shared/operation-result.mjs');
  const restored = {...completed,operation:{...completed.operation,status:'restored'}};
  assert.match(operationResultMessage(restored),/文件操作已恢复/);
  assert.doesNotMatch(operationResultMessage(restored),/未完成/);
  assert.equal(operationResultTone(restored),'success');
  assert.equal(operationResultTone({...restored,indexRefresh:{status:'failed'}}),'warning');
});
