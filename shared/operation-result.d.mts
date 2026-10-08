import type { OperationExecution } from '../src/types';
export function retainOperationResult(result: OperationExecution, accept: (result: OperationExecution) => void, reload: () => Promise<unknown>): Promise<OperationExecution>;
export function operationResultMessage(result: OperationExecution): string;
export function operationResultTone(result: OperationExecution): 'success' | 'warning';
