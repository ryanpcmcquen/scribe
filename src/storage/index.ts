import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname } from "path";
import { currentMonth, isDate, localDate } from "../date";

/**
 * Replace any occurrence of the current user's home directory path with `~`
 * so private home-directory paths are never written to the journal.
 */
export function redactHomePaths(text: string, home: string = homedir()): string {
  if (!text || !home || home === "/") return text;
  const normalized = home.replace(/\/+$/, "");
  if (!normalized) return text;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?=/|$|\\s|[.)"'\\],:;])`, "g"), "~");
}

export interface KnowledgeEntry {
  // YYYY-MM-DD
  date: string;
  title: string;
  workspace: string;
  agent: string;
  category: "finding" | "decision" | "work-log";
  body: string;
}

export type ReminderStatus = "pending" | "done" | "snoozed";

export interface ReminderEntry {
  // YYYY-MM-DD
  date: string;
  title: string;
  priority: "p1" | "p2" | "p3";
  context: string;
  action: string;
  status?: ReminderStatus;
  // YYYY-MM-DD
  snoozedUntil?: string;
  // YYYY-MM-DD
  completedAt?: string;
}

export interface ReminderUpdateInput {
  status: ReminderStatus;
  snoozedUntil?: string;
  completedAt?: string;
  month?: string;
}

const PRIORITY_ORDER: Record<ReminderEntry["priority"], number> = {
  p1: 0,
  p2: 1,
  p3: 2,
};

/**
 * Resolve the effective status of a reminder as of `asOfDate` (YYYY-MM-DD).
 * A snoozed reminder whose `snoozedUntil` date has arrived becomes `pending` again.
 */
export function effectiveReminderStatus(
  entry: ReminderEntry,
  asOfDate: string = localDate(),
): ReminderStatus {
  if (entry.status === "done") return "done";
  if (entry.status === "snoozed") {
    if (entry.snoozedUntil && entry.snoozedUntil <= asOfDate) {
      return "pending";
    }
    return "snoozed";
  }
  return "pending";
}

export function isReminderActive(
  entry: ReminderEntry,
  asOfDate: string = localDate(),
): boolean {
  return effectiveReminderStatus(entry, asOfDate) === "pending";
}

export type ScribeEntry = KnowledgeEntry | ReminderEntry;

export type EntryKind = "knowledge" | "reminders";

export class KnowledgeBase {
  constructor(private readonly workspacePath: string) {}

  private knowledgePath(month: string): string {
    return `${this.workspacePath}/knowledge/${month}/${month}-knowledge.md`;
  }

  private remindersPath(month: string): string {
    return `${this.workspacePath}/reminders/${month}/${month}-reminders.md`;
  }

  knowledgeFileFor(date: string): string {
    return this.knowledgePath(date.slice(0, 7));
  }

  reminderFileFor(date: string): string {
    return this.remindersPath(date.slice(0, 7));
  }

  private ensureFile(filePath: string, month: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, `## ${month}\n`);
    }
  }

  sanitizeKnowledgeEntry(entry: KnowledgeEntry): KnowledgeEntry {
    return {
      ...entry,
      title: redactHomePaths(entry.title).trim(),
      workspace: redactHomePaths(entry.workspace).trim(),
      agent: entry.agent.trim(),
      body: redactHomePaths(entry.body).trim(),
    };
  }

  sanitizeReminderEntry(entry: ReminderEntry): ReminderEntry {
    return {
      ...entry,
      title: redactHomePaths(entry.title).trim(),
      context: redactHomePaths(entry.context).trim(),
      action: redactHomePaths(entry.action).trim(),
    };
  }

  hasDuplicateKnowledge(entry: KnowledgeEntry): boolean {
    const sanitized = this.sanitizeKnowledgeEntry(entry);
    const month = sanitized.date.slice(0, 7);
    const existing = this.readKnowledge(month);
    return existing.some(
      (candidate) =>
        candidate.date === sanitized.date &&
        candidate.title.toLowerCase() === sanitized.title.toLowerCase() &&
        candidate.workspace === sanitized.workspace &&
        candidate.category === sanitized.category &&
        candidate.body === sanitized.body,
    );
  }

  hasDuplicateReminder(entry: ReminderEntry): boolean {
    const sanitized = this.sanitizeReminderEntry(entry);
    const month = sanitized.date.slice(0, 7);
    const existing = this.readReminders(month);
    return existing.some(
      (candidate) =>
        candidate.date === sanitized.date &&
        candidate.title.toLowerCase() === sanitized.title.toLowerCase() &&
        candidate.priority === sanitized.priority &&
        candidate.context === sanitized.context &&
        candidate.action === sanitized.action,
    );
  }

  appendKnowledgeEntry(entry: KnowledgeEntry): string {
    const sanitized = this.sanitizeKnowledgeEntry(entry);
    const month = sanitized.date.slice(0, 7);
    const filePath = this.knowledgePath(month);
    this.ensureFile(filePath, month);
    const entryBlock = `\n### ${sanitized.date} — ${sanitized.title}\n\n- **Workspace:** ${sanitized.workspace}\n- **Agent:** ${sanitized.agent}\n- **Category:** ${sanitized.category}\n\n${sanitized.body}\n`;
    appendFileSync(filePath, entryBlock);
    return filePath;
  }

  private formatReminderBlock(entry: ReminderEntry): string {
    const sanitized = this.sanitizeReminderEntry(entry);
    const metaLines: string[] = [`- **Priority:** ${sanitized.priority}`];
    if (sanitized.status) {
      metaLines.push(`- **Status:** ${sanitized.status}`);
    }
    if (sanitized.snoozedUntil) {
      metaLines.push(`- **Snoozed Until:** ${sanitized.snoozedUntil}`);
    }
    if (sanitized.completedAt) {
      metaLines.push(`- **Completed:** ${sanitized.completedAt}`);
    }
    metaLines.push(`- **Context:** ${sanitized.context}`);
    return `\n### ${sanitized.date} — ${sanitized.title}\n\n${metaLines.join("\n")}\n\n${sanitized.action}\n`;
  }

  private writeRemindersForMonth(month: string, entries: ReminderEntry[]): string {
    const filePath = this.remindersPath(month);
    mkdirSync(dirname(filePath), { recursive: true });
    const blocks = entries.map((entry) => this.formatReminderBlock(entry)).join("");
    writeFileSync(filePath, `## ${month}\n${blocks}`);
    return filePath;
  }

  appendReminder(entry: ReminderEntry): string {
    const sanitized = this.sanitizeReminderEntry(entry);
    const month = sanitized.date.slice(0, 7);
    const filePath = this.remindersPath(month);
    this.ensureFile(filePath, month);
    appendFileSync(filePath, this.formatReminderBlock(sanitized));
    return filePath;
  }

  readKnowledge(month: string = currentMonth()): KnowledgeEntry[] {
    const filePath = this.knowledgePath(month);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf8");
    const entries: KnowledgeEntry[] = [];
    const blocks = content.split(/^### /m).slice(1);

    for (const block of blocks) {
      const header = block.split("\n")[0] ?? "";
      const match = header.match(/^(\d{4}-\d{2}-\d{2}) — (.+)$/);
      if (!match) continue;

      const date = match[1];
      const title = match[2];
      const fields: Record<string, string> = {};
      const bodyLines: string[] = [];

      const lines = block.split("\n");
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^### /.test(line)) {
          break;
        }
        const fieldMatch = line.match(/^-\s+\*\*(.+?)\*\*\s*:?\s*(.*)$/);
        if (fieldMatch) {
          fields[fieldMatch[1].replace(/:$/, "").trim()] = fieldMatch[2].trim();
        } else {
          bodyLines.push(line);
        }
      }

      entries.push({
        date,
        title,
        workspace: fields["Workspace"] ?? "",
        agent: fields["Agent"] ?? "",
        category: (fields["Category"] ?? "work-log") as KnowledgeEntry["category"],
        body: bodyLines.join("\n").trim(),
      });
    }

    return entries;
  }

  readReminders(month: string = currentMonth()): ReminderEntry[] {
    const filePath = this.remindersPath(month);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf8");
    const entries: ReminderEntry[] = [];
    const blocks = content.split(/^### /m).slice(1);

    for (const block of blocks) {
      const header = block.split("\n")[0] ?? "";
      const match = header.match(/^(\d{4}-\d{2}-\d{2}) — (.+)$/);
      if (!match) continue;

      const date = match[1];
      const title = match[2];
      const fields: Record<string, string> = {};
      const actionLines: string[] = [];

      const lines = block.split("\n");
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^### /.test(line)) {
          break;
        }
        const fieldMatch = line.match(/^-\s+\*\*(.+?)\*\*\s*:?\s*(.*)$/);
        if (fieldMatch) {
          fields[fieldMatch[1].replace(/:$/, "").trim()] = fieldMatch[2].trim();
        } else {
          actionLines.push(line);
        }
      }

      const rawStatus = fields["Status"];
      const status: ReminderStatus | undefined =
        rawStatus === "pending" || rawStatus === "done" || rawStatus === "snoozed"
          ? rawStatus
          : undefined;
      const snoozedUntil = fields["Snoozed Until"] || undefined;
      const completedAt = fields["Completed"] || undefined;

      entries.push({
        date,
        title,
        priority: (fields["Priority"] ?? "p2") as ReminderEntry["priority"],
        context: fields["Context"] ?? "",
        action: actionLines.join("\n").trim(),
        ...(status ? { status } : {}),
        ...(snoozedUntil ? { snoozedUntil } : {}),
        ...(completedAt ? { completedAt } : {}),
      });
    }

    return entries;
  }

  readActiveReminders(
    month: string = currentMonth(),
    asOfDate: string = localDate(),
  ): ReminderEntry[] {
    return this.readReminders(month)
      .filter((entry) => isReminderActive(entry, asOfDate))
      .sort(
        (a, b) =>
          (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
          b.date.localeCompare(a.date),
      );
  }

  readAllKnowledge(): KnowledgeEntry[] {
    return this.listMonths("knowledge").flatMap((month) => this.readKnowledge(month));
  }

  readAllReminders(): ReminderEntry[] {
    return this.listMonths("reminders").flatMap((month) => this.readReminders(month));
  }

  readAllActiveReminders(asOfDate: string = localDate()): ReminderEntry[] {
    return this.readAllReminders()
      .filter((entry) => isReminderActive(entry, asOfDate))
      .sort(
        (a, b) =>
          (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
          b.date.localeCompare(a.date),
      );
  }

  updateReminderStatus(
    query: string,
    input: ReminderUpdateInput,
  ): { updated: ReminderEntry; path: string; month: string } {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      throw new Error("a reminder title or query is required");
    }

    if (input.status === "snoozed") {
      if (!input.snoozedUntil || !isDate(input.snoozedUntil)) {
        throw new Error(
          `invalid snooze date "${input.snoozedUntil ?? ""}" (expected YYYY-MM-DD)`,
        );
      }
    }

    const candidateMonths = input.month
      ? [input.month]
      : [...this.listMonths("reminders")].reverse();

    for (const month of candidateMonths) {
      const entries = this.readReminders(month);
      let index = entries.findIndex(
        (entry) => entry.title.toLowerCase() === needle,
      );
      if (index === -1) {
        index = entries.findIndex((entry) =>
          entry.title.toLowerCase().includes(needle),
        );
      }
      if (index === -1) continue;

      const current = entries[index];
      const updated: ReminderEntry = {
        date: current.date,
        title: current.title,
        priority: current.priority,
        context: current.context,
        action: current.action,
      };

      if (input.status === "done") {
        updated.status = "done";
        updated.completedAt = input.completedAt ?? localDate();
      } else if (input.status === "snoozed") {
        updated.status = "snoozed";
        updated.snoozedUntil = input.snoozedUntil;
      }
      // For "pending" (reopen), omit status/snoozedUntil/completedAt so it returns to clean pending state.

      entries[index] = updated;
      const path = this.writeRemindersForMonth(month, entries);
      return { updated, path, month };
    }

    throw new Error(`no reminder matching "${query}" found`);
  }

  listMonths(kind: EntryKind): string[] {
    const root = `${this.workspacePath}/${kind}`;
    if (!existsSync(root)) return [];

    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }
}
