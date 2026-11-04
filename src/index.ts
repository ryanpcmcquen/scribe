#!/usr/bin/env node
/**
 * Scribe — standalone markdown knowledge base companion.
 *
 * Core library exports. The command-line interface lives in `cli.ts`.
 */
export { Scribe } from "./scribe";
export {
  effectiveReminderStatus,
  isReminderActive,
  KnowledgeBase,
  redactHomePaths,
} from "./storage";
export { Git, isRemoteTarget } from "./git";
export { rankReminders, rankScribeEntries, composeFocus } from "./merge";
export { buildContextPack, searchKnowledgeBase } from "./search";
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
export {
  MCP_RESOURCES,
  MCP_TOOLS,
  runMcpServer,
  ScribeMcpServer,
} from "./mcp";
export {
  gitHookStatus,
  inferCategory,
  installGitHook,
  installOpenCodeSkill,
  runAgentStopHook,
  runPostCommitHook,
  uninstallGitHook,
} from "./hooks";
export {
  createOpenCodePlugin,
  SCRIBE_SYSTEM_DIRECTIVE,
} from "./plugins/opencode";

export type {
  KnowledgeEntry,
  ReminderEntry,
  ReminderStatus,
  ReminderUpdateInput,
  ScribeEntry,
} from "./storage";
export type { GitLike, PushResult } from "./git";
export type {
  ScribeOptions,
  CaptureResult,
  ReminderUpdateResult,
} from "./scribe";
export type { FocusItem, FocusSourceContribution } from "./merge";
export type {
  ContextOptions,
  ContextPack,
  SearchOptions,
  SearchResultItem,
} from "./search";
export type { ConfigOverrides, ScribeConfig } from "./config";
export type { JsonRpcRequest, JsonRpcResponse } from "./mcp";
export type {
  AgentStopPayload,
  GitHookInstallResult,
  HookCaptureOutcome,
  PostCommitHookOptions,
} from "./hooks";
export type { OpenCodePluginContext } from "./plugins/opencode";
