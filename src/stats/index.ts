import { resolvePath, tildifyPath } from "../config";
import { currentMonth, localDate } from "../date";
import {
  effectiveReminderStatus,
  KnowledgeBase,
  KnowledgeEntry,
  ReminderEntry,
} from "../storage";

export interface StatsOptions {
  month?: string;
  all?: boolean;
  workspace?: string;
  asOfDate?: string;
}

export interface CountItem {
  name: string;
  count: number;
}

export interface ScribeStats {
  scope: {
    month: string | null;
    workspace: string | null;
    months: string[];
  };
  knowledge: {
    total: number;
    byCategory: {
      decision: number;
      finding: number;
      "work-log": number;
    };
    byWorkspace: CountItem[];
    byAgent: CountItem[];
  };
  reminders: {
    total: number;
    pending: number;
    snoozed: number;
    done: number;
    byPriority: {
      p1: number;
      p2: number;
      p3: number;
    };
  };
  markdown: string;
}

function rankCounts(map: Map<string, number>): CountItem[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function computeStats(
  kb: KnowledgeBase,
  options: StatsOptions = {},
): ScribeStats {
  const asOfDate = options.asOfDate ?? localDate();
  const useAll = Boolean(options.all);
  const targetMonth = useAll ? null : (options.month ?? currentMonth());
  const normalizedWorkspace = options.workspace
    ? tildifyPath(resolvePath(options.workspace))
    : null;

  const monthsSet = new Set<string>([
    ...kb.listMonths("knowledge"),
    ...kb.listMonths("reminders"),
  ]);
  const months = useAll
    ? [...monthsSet].sort()
    : targetMonth
      ? [targetMonth]
      : [];

  let knowledgeEntries: KnowledgeEntry[] = useAll
    ? kb.readAllKnowledge()
    : kb.readKnowledge(targetMonth ?? undefined);

  if (normalizedWorkspace) {
    knowledgeEntries = knowledgeEntries.filter(
      (entry) => entry.workspace === normalizedWorkspace,
    );
  }

  const reminderEntries: ReminderEntry[] = useAll
    ? kb.readAllReminders()
    : kb.readReminders(targetMonth ?? undefined);

  const byCategory = {
    decision: 0,
    finding: 0,
    "work-log": 0,
  };
  const workspaceCounts = new Map<string, number>();
  const agentCounts = new Map<string, number>();

  for (const entry of knowledgeEntries) {
    if (entry.category in byCategory) {
      byCategory[entry.category]++;
    }
    const ws = entry.workspace || "(unknown)";
    workspaceCounts.set(ws, (workspaceCounts.get(ws) ?? 0) + 1);
    const ag = entry.agent || "(unknown)";
    agentCounts.set(ag, (agentCounts.get(ag) ?? 0) + 1);
  }

  const reminderStatusCounts = {
    pending: 0,
    snoozed: 0,
    done: 0,
  };
  const byPriority = {
    p1: 0,
    p2: 0,
    p3: 0,
  };

  for (const reminder of reminderEntries) {
    const status = effectiveReminderStatus(reminder, asOfDate);
    reminderStatusCounts[status]++;
    if (reminder.priority in byPriority) {
      byPriority[reminder.priority]++;
    }
  }

  const byWorkspace = rankCounts(workspaceCounts);
  const byAgent = rankCounts(agentCounts);

  const headingScope = targetMonth ?? "all months";
  const lines: string[] = [
    `## Scribe Stats (${headingScope}${normalizedWorkspace ? ` · ${normalizedWorkspace}` : ""})`,
    "",
    `- **Knowledge entries:** ${knowledgeEntries.length} (decisions: ${byCategory.decision}, findings: ${byCategory.finding}, work-log: ${byCategory["work-log"]})`,
    `- **Reminders:** ${reminderEntries.length} (pending: ${reminderStatusCounts.pending}, snoozed: ${reminderStatusCounts.snoozed}, done: ${reminderStatusCounts.done})`,
  ];

  if (byWorkspace.length > 0) {
    lines.push(
      `- **Top workspaces:** ${byWorkspace
        .slice(0, 5)
        .map((item) => `${item.name} (${item.count})`)
        .join(", ")}`,
    );
  }

  if (byAgent.length > 0) {
    lines.push(
      `- **Agents:** ${byAgent
        .map((item) => `${item.name} (${item.count})`)
        .join(", ")}`,
    );
  }

  return {
    scope: {
      month: targetMonth,
      workspace: normalizedWorkspace,
      months,
    },
    knowledge: {
      total: knowledgeEntries.length,
      byCategory,
      byWorkspace,
      byAgent,
    },
    reminders: {
      total: reminderEntries.length,
      ...reminderStatusCounts,
      byPriority,
    },
    markdown: `${lines.join("\n")}\n`,
  };
}
