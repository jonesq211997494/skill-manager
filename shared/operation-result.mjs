// 先提交权威文件结果，再读取界面数据；读取失败不会回退已确认的操作。
export async function retainOperationResult(result, accept, reload) {
  accept(result);
  try {
    await reload();
    return {...result,viewRefresh:{status:'completed'}};
  } catch(error) {
    return {...result,viewRefresh:{status:'failed',error:{code:error?.code || 'VIEW_REFRESH_FAILED',message:error?.message || String(error)}}};
  }
}

export function operationResultMessage(result) {
  const status = result.operation.status;
  const fileMessage = status === 'completed' ? '文件操作已完成' : status === 'restored' ? '文件操作已恢复' : status === 'partial' ? '文件操作部分完成，请查看各目标结果' : status === 'recovery-required' ? '文件操作需要恢复，请查看操作记录' : '文件操作未完成，请查看操作记录';
  const refreshMessage = result.indexRefresh.status === 'failed' ? '索引刷新失败，可仅刷新索引' : result.indexRefresh.status === 'skipped' ? '索引刷新已延后，请在下次打开时刷新' : result.viewRefresh?.status === 'failed' ? '界面数据读取失败，可仅刷新索引' : '索引已刷新';
  return `${fileMessage}；${refreshMessage}。${result.indexRefresh.metadataSkipped?.length ? '已保留取消登记设置，相关目录未重新加入扫描。' : ''}`;
}

export function operationResultTone(result) {
  return ['completed','restored'].includes(result.operation.status) && result.indexRefresh.status === 'completed' && result.viewRefresh?.status !== 'failed' ? 'success' : 'warning';
}
