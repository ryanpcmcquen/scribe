#!/usr/bin/env node
/**
 * Scribe — standalone markdown knowledge base companion.
 *
 * Phase 2 scaffold: wires capture -> storage -> git (commit/push).
 */
export { Scribe } from "./scribe";
export { KnowledgeBase } from "./storage";
export { Git } from "./git";
export { rankScribeEntries } from "./merge";
export type { KnowledgeEntry, ReminderEntry } from "./storage";
export type { GitLike } from "./git";
export type { ScribeOptions } from "./scribe";
export type { FocusItem } from "./merge";
