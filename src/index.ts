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
  redactSecrets,
} from "./storage";
export { Git, isRemoteTarget } from "./git";
export {
  composeFocus,
  composeFocusFromInput,
  formatFocusBullets,
  normalizeExternalCandidates,
  rankReminders,
  rankScribeEntries,
  recencyDecay,
  SOURCE_DEFAULT_WEIGHTS,
} from "./merge";
export { buildContextPack, searchKnowledgeBase } from "./search";
export { computeStats } from "./stats";
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
  ALL_SKILL_AGENTS,
  discoverGitRepos,
  gitHooksStatusInDir,
  gitHookStatus,
  inferCategory,
  installAgentSkills,
  installGitHook,
  installGitHooksInDir,
  installOpenCodeSkill,
  runAgentStopHook,
  runPostCommitHook,
  uninstallGitHook,
  uninstallGitHooksInDir,
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
export type { GitLike, PullResult, PushResult, SyncResult } from "./git";
export type {
  ScribeOptions,
  CaptureResult,
  ReminderUpdateResult,
} from "./scribe";
export type {
  ComposeFocusInput,
  ComposeFocusOptions,
  ExternalFocusCandidate,
  FocusItem,
  FocusSourceContribution,
  FocusSourceKind,
} from "./merge";
export type {
  ContextOptions,
  ContextPack,
  SearchOptions,
  SearchResultItem,
} from "./search";
export type { CountItem, ScribeStats, StatsOptions } from "./stats";
export type { ConfigOverrides, ScribeConfig } from "./config";
export type { JsonRpcRequest, JsonRpcResponse } from "./mcp";
export type {
  AgentSkillInstallResult,
  AgentSkillTarget,
  AgentStopPayload,
  DiscoveredRepoHookStatus,
  GitHookInstallResult,
  HookCaptureOutcome,
  PostCommitHookOptions,
} from "./hooks";
export type { OpenCodePluginContext } from "./plugins/opencode";
