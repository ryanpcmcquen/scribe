import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { currentMonth } from "../date";

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

  appendKnowledgeEntry(entry: KnowledgeEntry): string {
    const month = entry.date.slice(0, 7); // YYYY-MM
    const filePath = this.knowledgePath(month);
    this.ensureFile(filePath, month);
    const entryBlock = `\n### ${entry.date} — ${entry.title}\n\n- **Workspace:** ${entry.workspace}\n- **Agent:** ${entry.agent}\n- **Category:** ${entry.category}\n\n${entry.body}\n`;
    appendFileSync(filePath, entryBlock);
    return filePath;
  }

  appendReminder(entry: ReminderEntry): string {
    const month = entry.date.slice(0, 7); // YYYY-MM
    const filePath = this.remindersPath(month);
    this.ensureFile(filePath, month);
    const entryBlock = `\n### ${entry.date} — ${entry.title}\n\n- **Priority:** ${entry.priority}\n- **Context:** ${entry.context}\n\n${entry.action}\n`;
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
