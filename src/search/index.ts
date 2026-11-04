import { resolvePath, tildifyPath } from "../config";
import { localDate } from "../date";
import {
  effectiveReminderStatus,
  isReminderActive,
  KnowledgeBase,
  KnowledgeEntry,
  ReminderEntry,
  ReminderStatus,
} from "../storage";

export interface SearchOptions {
  query?: string;
  workspace?: string;
  category?: KnowledgeEntry["category"];
  status?: ReminderStatus | "all";
  month?: string;
  kind?: "all" | "knowledge" | "reminders";
  limit?: number;
  asOfDate?: string;
}

export interface SearchResultItem {
  kind: "knowledge" | "reminder";
  score: number;
  date: string;
  title: string;
  workspace?: string;
  category?: KnowledgeEntry["category"];
  priority?: ReminderEntry["priority"];
  status?: ReminderStatus;
  snippet: string;
  knowledge?: KnowledgeEntry;
  reminder?: ReminderEntry;
}

export interface ContextOptions {
  workspace?: string;
  query?: string;
  limit?: number;
  asOfDate?: string;
}

export interface ContextPack {
  workspace: string | null;
  query: string | null;
  decisions: KnowledgeEntry[];
  findings: KnowledgeEntry[];
  recentWork: KnowledgeEntry[];
  activeReminders: ReminderEntry[];
  markdown: string;
}

const CATEGORY_BASE_SCORE: Record<KnowledgeEntry["category"], number> = {
  decision: 3,
  finding: 2,
  "work-log": 1,
};

const PRIORITY_BASE_SCORE: Record<ReminderEntry["priority"], number> = {
  p1: 4,
  p2: 3,
  p3: 2,
};

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function normalizeWorkspaceFilter(workspace?: string): string | undefined {
  if (!workspace || !workspace.trim()) return undefined;
  return tildifyPath(resolvePath(workspace.trim()));
}

function matchesWorkspace(entryWorkspace: string, filter: string): boolean {
  if (!entryWorkspace) return false;
  if (entryWorkspace === filter) return true;
  const entryBase = entryWorkspace.split("/").filter(Boolean).pop() ?? "";
  const filterBase = filter.split("/").filter(Boolean).pop() ?? "";
  return Boolean(entryBase && entryBase === filterBase && !filter.includes("/"));
}

function makeSnippet(text: string, maxLen = 180): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 3)}...`;
}

function scoreTextMatch(
  phrase: string,
  tokens: string[],
  title: string,
  secondary: string,
  body: string,
): number {
  if (!phrase && tokens.length === 0) return 1;

  const lowerTitle = title.toLowerCase();
  const lowerSecondary = secondary.toLowerCase();
  const lowerBody = body.toLowerCase();

  let score = 0;
  if (phrase) {
    if (lowerTitle.includes(phrase)) score += 10;
    if (lowerSecondary.includes(phrase)) score += 4;
    if (lowerBody.includes(phrase)) score += 5;
  }

  let matchedTokens = 0;
  for (const token of tokens) {
    let tokenMatched = false;
    if (lowerTitle.includes(token)) {
      score += 4;
      tokenMatched = true;
    }
    if (lowerSecondary.includes(token)) {
      score += 2;
      tokenMatched = true;
    }
    if (lowerBody.includes(token)) {
      score += 2;
      tokenMatched = true;
    }
    if (tokenMatched) matchedTokens++;
  }

  if (tokens.length > 0 && matchedTokens === 0) {
    return 0;
  }
  if (tokens.length > 1 && matchedTokens === tokens.length) {
    score += 4;
  }
  return score;
}

export function searchKnowledgeBase(
  storage: KnowledgeBase,
  options: SearchOptions = {},
): SearchResultItem[] {
  const phrase = (options.query ?? "").trim().toLowerCase();
  const tokens = tokenizeQuery(phrase);
  const workspaceFilter = normalizeWorkspaceFilter(options.workspace);
  const kind = options.kind ?? "all";
  const limit = options.limit && options.limit > 0 ? options.limit : 20;
  const asOfDate = options.asOfDate ?? localDate();

  const results: SearchResultItem[] = [];

  if (kind === "all" || kind === "knowledge") {
    const entries = options.month
      ? storage.readKnowledge(options.month)
      : storage.readAllKnowledge();

    for (const entry of entries) {
      if (options.category && entry.category !== options.category) continue;
      if (workspaceFilter && !matchesWorkspace(entry.workspace, workspaceFilter)) {
        continue;
      }

      const matchScore = scoreTextMatch(
        phrase,
        tokens,
        entry.title,
        `${entry.workspace} ${entry.category} ${entry.agent}`,
        entry.body,
      );
      if (matchScore === 0) continue;

      const score = matchScore + (CATEGORY_BASE_SCORE[entry.category] ?? 1);
      results.push({
        kind: "knowledge",
        score,
        date: entry.date,
        title: entry.title,
        workspace: entry.workspace,
        category: entry.category,
        snippet: makeSnippet(entry.body || entry.title),
        knowledge: entry,
      });
    }
  }

  if (
    (kind === "all" || kind === "reminders") &&
    !options.category &&
    (!workspaceFilter || kind === "reminders")
  ) {
    const reminders = options.month
      ? storage.readReminders(options.month)
      : storage.readAllReminders();

    for (const reminder of reminders) {
      const status = effectiveReminderStatus(reminder, asOfDate);
      if (
        options.status &&
        options.status !== "all" &&
        status !== options.status
      ) {
        continue;
      }

      const matchScore = scoreTextMatch(
        phrase,
        tokens,
        reminder.title,
        `${reminder.priority} ${status} ${reminder.context}`,
        `${reminder.context}\n${reminder.action}`,
      );
      if (matchScore === 0) continue;

      const score = matchScore + (PRIORITY_BASE_SCORE[reminder.priority] ?? 1);
      results.push({
        kind: "reminder",
        score,
        date: reminder.date,
        title: reminder.title,
        priority: reminder.priority,
        status,
        snippet: makeSnippet(reminder.action || reminder.context || reminder.title),
        reminder,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .slice(0, limit);
}

export function buildContextPack(
  storage: KnowledgeBase,
  options: ContextOptions = {},
): ContextPack {
  const workspaceFilter = normalizeWorkspaceFilter(options.workspace);
  const query = options.query?.trim() || null;
  const perSectionLimit = options.limit && options.limit > 0 ? options.limit : 5;
  const asOfDate = options.asOfDate ?? localDate();

  let knowledge = storage.readAllKnowledge();
  if (workspaceFilter) {
    knowledge = knowledge.filter((entry) =>
      matchesWorkspace(entry.workspace, workspaceFilter),
    );
  }

  if (query) {
    const matched = searchKnowledgeBase(storage, {
      query,
      workspace: options.workspace,
      kind: "knowledge",
      limit: perSectionLimit * 4,
      asOfDate,
    });
    knowledge = matched
      .map((item) => item.knowledge)
      .filter((entry): entry is KnowledgeEntry => Boolean(entry));
  } else {
    knowledge = [...knowledge].sort((a, b) => b.date.localeCompare(a.date));
  }

  const decisions = knowledge
    .filter((entry) => entry.category === "decision")
    .slice(0, perSectionLimit);
  const findings = knowledge
    .filter((entry) => entry.category === "finding")
    .slice(0, perSectionLimit);
  const recentWork = knowledge
    .filter((entry) => entry.category === "work-log")
    .slice(0, perSectionLimit);

  const activeReminders = storage
    .readAllReminders()
    .filter((entry) => isReminderActive(entry, asOfDate))
    .sort(
      (a, b) =>
        (PRIORITY_BASE_SCORE[b.priority] ?? 0) -
          (PRIORITY_BASE_SCORE[a.priority] ?? 0) ||
        b.date.localeCompare(a.date),
    )
    .slice(0, perSectionLimit);

  const lines: string[] = [];
  lines.push(
    `## Scribe Context${workspaceFilter ? ` (${workspaceFilter})` : ""}`,
  );

  if (activeReminders.length > 0) {
    lines.push("\n### Pending Reminders");
    for (const r of activeReminders) {
      lines.push(
        `- **[${r.priority.toUpperCase()}] ${r.title}** (${r.date}): ${makeSnippet(r.action || r.context, 140)}`,
      );
    }
  }

  if (decisions.length > 0) {
    lines.push("\n### Key Decisions");
    for (const d of decisions) {
      lines.push(`- **${d.title}** (${d.date}): ${makeSnippet(d.body, 140)}`);
    }
  }

  if (findings.length > 0) {
    lines.push("\n### Findings");
    for (const f of findings) {
      lines.push(`- **${f.title}** (${f.date}): ${makeSnippet(f.body, 140)}`);
    }
  }

  if (recentWork.length > 0) {
    lines.push("\n### Recent Work");
    for (const w of recentWork) {
      lines.push(`- **${w.title}** (${w.date}): ${makeSnippet(w.body, 140)}`);
    }
  }

  if (
    activeReminders.length === 0 &&
    decisions.length === 0 &&
    findings.length === 0 &&
    recentWork.length === 0
  ) {
    lines.push("\nNo matching knowledge entries or pending reminders.");
  }

  return {
    workspace: workspaceFilter ?? null,
    query,
    decisions,
    findings,
    recentWork,
    activeReminders,
    markdown: `${lines.join("\n")}\n`,
  };
}
