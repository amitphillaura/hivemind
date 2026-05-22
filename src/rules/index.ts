/**
 * Barrel for `src/rules/`.
 *
 * Consumers (CLI handler, future SessionStart renderer) import only from
 * this entry point so internal restructuring (e.g. splitting write.ts
 * later) stays a non-breaking change for callers.
 */

export { insertRule, editRule, markRuleDone, _MAX_TEXT_LENGTH } from "./write.js";
export type {
  InsertRuleInput,
  EditRuleInput,
  WriteResult,
  RuleStatus,
} from "./write.js";

export { listRules, getRuleLatest } from "./read.js";
export type { RuleRow, ListRulesOpts, QueryFn } from "./read.js";
