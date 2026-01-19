/**
 * Task Types - конкретные типы данных для задач
 *
 * Extensibility: добавляйте новые типы в TaskData union
 */

import type { ModuleNode } from '../plugins/analysis/ast/types.js';

// === TASK TYPE LITERALS ===
export type TaskType = 'ANALYZE_MODULE';
// При добавлении нового типа: 'ANALYZE_MODULE' | 'NEW_TYPE';

// === TASK DATA BY TYPE ===

/**
 * Данные для ANALYZE_MODULE задачи
 */
export interface AnalyzeModuleData {
  module: ModuleNode;
}

// При добавлении нового типа:
// export interface NewTypeData {
//   ...
// }

// === UNION TYPE ===

/**
 * Union всех возможных TaskData
 * Расширяется при добавлении новых типов задач
 */
export type TaskData = AnalyzeModuleData;
// При добавлении: AnalyzeModuleData | NewTypeData;

// === TYPE GUARDS ===

export function isAnalyzeModuleData(data: TaskData): data is AnalyzeModuleData {
  return 'module' in data && data.module !== null && typeof data.module === 'object';
}
