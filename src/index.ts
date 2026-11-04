#!/usr/bin/env node
/**
 * Scribe — standalone markdown knowledge base companion.
 *
 * Core library exports. The command-line interface lives in `cli.ts`.
 */
export { Scribe } from "./scribe";
export { KnowledgeBase } from "./storage";
export { Git, isRemoteTarget } from "./git";
export { rankScribeEntries, composeFocus } from "./merge";
export {
  DEFAULT_AGENT,
  DEFAULT_WORKSPACE,
  defaultConfigPath,
  expandHome,
  loadConfig,
  resolvePath,
  saveConfig,
  tildifyPath,
} from "./config";
export { currentMonth, isDate, isMonth, localDate } from "./date";

export type { KnowledgeEntry, ReminderEntry, ScribeEntry } from "./storage";
export type { GitLike, PushResult } from "./git";
export type { ScribeOptions, CaptureResult } from "./scribe";
export type { FocusItem, FocusSourceContribution } from "./merge";
export type { ConfigOverrides, ScribeConfig } from "./config";
