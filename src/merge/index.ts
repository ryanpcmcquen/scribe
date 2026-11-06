import { resolvePath, tildifyPath } from "../config";
import { localDate } from "../date";
import {
  isReminderActive,
  KnowledgeEntry,
  ReminderEntry,
} from "../storage";

export type FocusSourceKind =
  | "scribe"
  | "scribe-reminder"
  | "git"
  | "session"
  | "mcp"
  | string;

export interface FocusItem {
  entry: KnowledgeEntry;
  score: number;
  source: FocusSourceKind;
  kind?: "knowledge" | "reminder" | "git" | "session" | "mcp";
  reminder?: ReminderEntry;
}

export interface FocusSourceContribution {
  source: FocusSourceKind;
  items: FocusItem[];
}

export interface ExternalFocusCandidate {
  source?: "git" | "session" | "mcp" | string;
  title: string;
  workspace?: string;
  date?: string;
  body?: string;
  score?: number;
  uncommitted?: boolean;
  priority?: "p1" | "p2" | "p3";
}

export interface ComposeFocusInput {
  sessions?: ExternalFocusCandidate[];
  git?: ExternalFocusCandidate[];
  mcp?: ExternalFocusCandidate[];
  additionalSources?: FocusSourceContribution[];
}

export interface ComposeFocusOptions {
  workspace?: string;
  limit?: number;
  dedupeByTitle?: boolean;
  asOfDate?: string;
}

export const SOURCE_DEFAULT_WEIGHTS: Record<string, number> = {
  git: 5,
  mcp: 4,
  session: 3,
  scribe: 2,
};

const CATEGORY_WEIGHTS: Record<string, number> = {
  decision: 3,
  finding: 2,
  "work-log": 1,
};

const REMINDER_PRIORITY_WEIGHTS: Record<ReminderEntry["priority"], number> = {
  p1: 4,
  p2: 3,
  p3: 2,
};

function workspaceShortLabel(workspace: string): string {
  const trimmed = workspace.trim().replace(/\/+$/, "");
  if (!trimmed) return "general";
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

function parseUtcDayMillis(dateStr: string): number | null {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Compute age-based score decay for a knowledge entry relative to `asOfDate`.
 * Today's entries have 0 decay; older entries decay gently so fresh findings
 * and decisions surface above stale entries in `scribe focus`.
 */
export function recencyDecay(
  entryDate: string,
  asOfDate: string = localDate(),
): number {
  const entryMs = parseUtcDayMillis(entryDate);
  const asOfMs = parseUtcDayMillis(asOfDate);
  if (entryMs === null || asOfMs === null) return 0;

  const days = Math.floor((asOfMs - entryMs) / 86_400_000);
  if (days <= 0) return 0;
  if (days <= 3) return 0.25;
  if (days <= 7) return 0.5;
  if (days <= 14) return 1.0;
  if (days <= 30) return 1.25;
  return 1.5;
}

export function rankScribeEntries(
  entries: KnowledgeEntry[],
  asOfDate: string = localDate(),
): FocusItem[] {
  const items: FocusItem[] = entries.map((entry) => {
    const base = CATEGORY_WEIGHTS[entry.category] ?? 0;
    const decay = recencyDecay(entry.date, asOfDate);
    const score =
      base > 0 ? Math.max(0.25, Number((base - decay).toFixed(2))) : 0;
    return {
      entry,
      score,
      source: "scribe" as const,
      kind: "knowledge" as const,
    };
  });
  return items.sort(
    (a, b) => b.score - a.score || b.entry.date.localeCompare(a.entry.date),
  );
}

export function rankReminders(
  reminders: ReminderEntry[],
  asOfDate: string = localDate(),
): FocusItem[] {
  const items: FocusItem[] = reminders
    .filter((reminder) => isReminderActive(reminder, asOfDate))
    .map((reminder) => ({
      entry: {
        date: reminder.date,
        title: `[Reminder ${reminder.priority.toUpperCase()}] ${reminder.title}`,
        workspace: "",
        agent: "scribe",
        category: "work-log",
        body: reminder.action || reminder.context,
      },
      score: REMINDER_PRIORITY_WEIGHTS[reminder.priority] ?? 2,
      source: "scribe" as const,
      kind: "reminder" as const,
      reminder,
    }));

  return items.sort(
    (a, b) => b.score - a.score || b.entry.date.localeCompare(a.entry.date),
  );
}

export function normalizeExternalCandidates(
  candidates: ExternalFocusCandidate[],
  defaultSource: "git" | "session" | "mcp" | string,
  asOfDate: string = localDate(),
): FocusSourceContribution {
  const items: FocusItem[] = [];

  for (const candidate of candidates) {
    const title = (candidate.title ?? "").replace(/\s+/g, " ").trim();
    if (!title) continue;

    const source = candidate.source || defaultSource;
    const baseWeight =
      candidate.score ??
      (source === "git"
        ? candidate.uncommitted
          ? 5
          : 4
        : source === "mcp"
          ? candidate.priority
            ? (REMINDER_PRIORITY_WEIGHTS[candidate.priority] ?? 4)
            : 4
          : (SOURCE_DEFAULT_WEIGHTS[source] ?? 3));

    const workspace = candidate.workspace
      ? tildifyPath(resolvePath(candidate.workspace))
      : "";

    items.push({
      entry: {
        date: candidate.date || asOfDate,
        title,
        workspace,
        agent: source,
        category: "work-log",
        body: candidate.body ?? "",
      },
      score: baseWeight,
      source,
      kind:
        source === "git" || source === "session" || source === "mcp"
          ? source
          : undefined,
    });
  }

  return { source: defaultSource, items };
}

export function composeFocus(
  scribeItems: FocusItem[],
  additionalSources: FocusSourceContribution[] = [],
  options: ComposeFocusOptions = {},
): FocusItem[] {
  const workspaceFilter = options.workspace
    ? tildifyPath(resolvePath(options.workspace))
    : undefined;
  const dedupeByTitle = options.dedupeByTitle ?? true;

  const raw: FocusItem[] = [...scribeItems];
  for (const source of additionalSources) {
    for (const item of source.items) {
      raw.push({
        ...item,
        source: item.source || source.source,
      });
    }
  }

  const filtered = workspaceFilter
    ? raw.filter(
        (item) =>
          item.entry.workspace === workspaceFilter ||
          (item.kind === "reminder" && item.entry.workspace === ""),
      )
    : raw;

  const sorted = [...filtered].sort(
    (a, b) => b.score - a.score || b.entry.date.localeCompare(a.entry.date),
  );

  const deduped: FocusItem[] = [];
  const seenKeys = new Set<string>();
  for (const item of sorted) {
    if (dedupeByTitle) {
      const key = `${item.entry.workspace.toLowerCase()}::${item.entry.title.toLowerCase()}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    deduped.push(item);
  }

  if (options.limit && options.limit > 0) {
    return deduped.slice(0, options.limit);
  }
  return deduped;
}

export function composeFocusFromInput(
  scribeItems: FocusItem[],
  input: ComposeFocusInput = {},
  options: ComposeFocusOptions = {},
): FocusItem[] {
  const asOfDate = options.asOfDate ?? localDate();
  const contributions: FocusSourceContribution[] = [];

  if (Array.isArray(input.git) && input.git.length > 0) {
    contributions.push(normalizeExternalCandidates(input.git, "git", asOfDate));
  }
  if (Array.isArray(input.mcp) && input.mcp.length > 0) {
    contributions.push(normalizeExternalCandidates(input.mcp, "mcp", asOfDate));
  }
  if (Array.isArray(input.sessions) && input.sessions.length > 0) {
    contributions.push(
      normalizeExternalCandidates(input.sessions, "session", asOfDate),
    );
  }
  if (Array.isArray(input.additionalSources)) {
    contributions.push(...input.additionalSources);
  }

  return composeFocus(scribeItems, contributions, options);
}

/**
 * Format ranked focus items as plain `- <workspace>: <text>` bullet lines
 * ready for Flint's morning brief (`brief_add_mcp_focus` / focus synthesis).
 */
export function formatFocusBullets(items: FocusItem[]): string {
  if (items.length === 0) return "";
  return `${items
    .map((item) => {
      const label = item.entry.workspace
        ? workspaceShortLabel(item.entry.workspace)
        : "reminder";
      return `- ${label}: ${item.entry.title}`;
    })
    .join("\n")}\n`;
}
