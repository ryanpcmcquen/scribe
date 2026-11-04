import {
  isReminderActive,
  KnowledgeEntry,
  ReminderEntry,
} from "../storage";
import { localDate } from "../date";

export interface FocusItem {
  entry: KnowledgeEntry;
  score: number;
  source: "scribe";
  kind?: "knowledge" | "reminder";
  reminder?: ReminderEntry;
}

export interface FocusSourceContribution {
  source: string;
  items: FocusItem[];
}

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

export function rankScribeEntries(entries: KnowledgeEntry[]): FocusItem[] {
  const items: FocusItem[] = entries.map((entry) => ({
    entry,
    score: CATEGORY_WEIGHTS[entry.category] ?? 0,
    source: "scribe" as const,
  }));
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

export function composeFocus(
  scribeItems: FocusItem[],
  additionalSources: FocusSourceContribution[] = [],
): FocusItem[] {
  const merged: FocusItem[] = [...scribeItems];
  for (const source of additionalSources) {
    merged.push(...source.items);
  }
  return merged.sort(
    (a, b) => b.score - a.score || b.entry.date.localeCompare(a.entry.date),
  );
}
