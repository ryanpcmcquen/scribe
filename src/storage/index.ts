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
import { currentMonth } from "../date";

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
  date: string; // YYYY-MM-DD
  title: string;
  workspace: string;
  agent: string;
  category: "finding" | "decision" | "work-log";
  body: string;
}

export interface ReminderEntry {
  date: string; // YYYY-MM-DD
  title: string;
  priority: "p1" | "p2" | "p3";
  context: string;
  action: string;
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
    return this.knowledgePath(date.slice(0, 7)); // YYYY-MM
  }

  reminderFileFor(date: string): string {
    return this.remindersPath(date.slice(0, 7)); // YYYY-MM
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
    const month = sanitized.date.slice(0, 7); // YYYY-MM
    const filePath = this.knowledgePath(month);
    this.ensureFile(filePath, month);
    const entryBlock = `\n### ${sanitized.date} — ${sanitized.title}\n\n- **Workspace:** ${sanitized.workspace}\n- **Agent:** ${sanitized.agent}\n- **Category:** ${sanitized.category}\n\n${sanitized.body}\n`;
    appendFileSync(filePath, entryBlock);
    return filePath;
  }

  appendReminder(entry: ReminderEntry): string {
    const sanitized = this.sanitizeReminderEntry(entry);
    const month = sanitized.date.slice(0, 7); // YYYY-MM
    const filePath = this.remindersPath(month);
    this.ensureFile(filePath, month);
    const entryBlock = `\n### ${sanitized.date} — ${sanitized.title}\n\n- **Priority:** ${sanitized.priority}\n- **Context:** ${sanitized.context}\n\n${sanitized.action}\n`;
    appendFileSync(filePath, entryBlock);
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

      entries.push({
        date,
        title,
        priority: (fields["Priority"] ?? "p2") as ReminderEntry["priority"],
        context: fields["Context"] ?? "",
        action: actionLines.join("\n").trim(),
      });
    }

    return entries;
  }

  readAllKnowledge(): KnowledgeEntry[] {
    return this.listMonths("knowledge").flatMap((month) => this.readKnowledge(month));
  }

  readAllReminders(): ReminderEntry[] {
    return this.listMonths("reminders").flatMap((month) => this.readReminders(month));
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
