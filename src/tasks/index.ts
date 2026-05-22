/**
 * Barrel for `src/tasks/`.
 *
 * Consumers (CLI handler, future SessionStart renderer, T4 LLM hook)
 * import only from this entry point so internal refactors stay
 * non-breaking for callers.
 */

export {
  insertTask,
  editTask,
  markTaskDone,
  assignTask,
  _MAX_TEXT_LENGTH,
} from "./write.js";
export type {
  InsertTaskInput,
  EditTaskInput,
  WriteResult,
  TaskScope,
  TaskStatus,
} from "./write.js";

export { listTasks, getTaskLatest } from "./read.js";
export type { TaskRow, ListTasksOpts, ScopeFilter, QueryFn } from "./read.js";

export { parseKpis, stringifyKpis } from "./kpi-validator.js";
export type { Kpi } from "./kpi-validator.js";
