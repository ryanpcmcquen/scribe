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

/**
 * Scrub common secret and credential formats before writing entries to disk
 * so tokens or private keys are never committed to the journal repository.
 */
export function redactSecrets(
  text: string,
  redactionLiterals: readonly string[] = [],
): string {
  if (!text) return text;
  let redacted = text
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(
      /\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[REDACTED_GITHUB_TOKEN]",
    )
    .replace(
      /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
      "[REDACTED_STRIPE_KEY]",
    )
    .replace(
      /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
      "[REDACTED_API_KEY]",
    )
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_API_KEY]")
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(
      /https?:\/\/hooks\.slack\.com\/services\/[A-Z0-9]{6,}\/[A-Z0-9]{6,}\/[A-Za-z0-9_-]{16,}/gi,
      "[REDACTED_SLACK_WEBHOOK]",
    )
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_GITLAB_TOKEN]")
    .replace(/\bnpm_[A-Za-z0-9]{30,}\b/g, "[REDACTED_NPM_TOKEN]")
    .replace(/\bpypi-[A-Za-z0-9_-]{40,}\b/g, "[REDACTED_PYPI_TOKEN]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED_JWT]",
    )
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token|credential)\s*[:=]\s*)(["']?)[^\s"'`,;]{8,}\2/gi,
      "$1[REDACTED_CREDENTIAL]",
    )
    .replace(/(:\/\/[^:/\s]+:)[^@/\s]+@/g, "$1[REDACTED_CREDENTIAL]@")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED_TOKEN]");

  for (const literal of redactionLiterals) {
    if (literal) {
      redacted = redacted.split(literal).join("[REDACTED_CUSTOM]");
    }
  }
  return redacted;
}

function sanitizeText(
  text: string,
  redactionLiterals: readonly string[],
): string {
  return redactSecrets(redactHomePaths(text), redactionLiterals).trim();
}

export interface KnowledgeEntry {
  // YYYY-MM-DD
  date: string;
  title: string;
  workspace: string;
  agent: string;
  category: "finding" | "decision" | "work-log";
  body: string;
  source?: string;
  sourceId?: string;
  summary?: string;
  tags?: string[];
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
  constructor(
    private readonly workspacePath: string,
    private readonly redactionLiterals: readonly string[] = [],
  ) {}

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
      title: sanitizeText(entry.title, this.redactionLiterals),
      workspace: sanitizeText(entry.workspace, this.redactionLiterals),
      agent: sanitizeText(entry.agent, this.redactionLiterals),
      body: sanitizeText(entry.body, this.redactionLiterals),
      ...(entry.source
        ? { source: sanitizeText(entry.source, this.redactionLiterals) }
        : {}),
      ...(entry.sourceId
        ? { sourceId: sanitizeText(entry.sourceId, this.redactionLiterals) }
        : {}),
      ...(entry.summary
        ? { summary: sanitizeText(entry.summary, this.redactionLiterals) }
        : {}),
      ...(entry.tags?.length
        ? {
            tags: entry.tags.map((tag) =>
              sanitizeText(tag, this.redactionLiterals),
            ),
          }
        : {}),
    };
  }

  sanitizeReminderEntry(entry: ReminderEntry): ReminderEntry {
    return {
      ...entry,
      title: sanitizeText(entry.title, this.redactionLiterals),
      context: sanitizeText(entry.context, this.redactionLiterals),
      action: sanitizeText(entry.action, this.redactionLiterals),
    };
  }

  hasDuplicateKnowledge(entry: KnowledgeEntry): boolean {
    const sanitized = this.sanitizeKnowledgeEntry(entry);
    const month = sanitized.date.slice(0, 7);
    const existing = this.readKnowledge(month);
    return existing.some(
      (candidate) =>
        (sanitized.sourceId &&
          candidate.sourceId === sanitized.sourceId &&
          candidate.title.toLowerCase() === sanitized.title.toLowerCase() &&
          candidate.body === sanitized.body) ||
        (candidate.date === sanitized.date &&
          candidate.title.toLowerCase() === sanitized.title.toLowerCase() &&
          candidate.workspace === sanitized.workspace &&
          candidate.category === sanitized.category &&
          candidate.body === sanitized.body),
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
    const metadata = [
      `- **Workspace:** ${sanitized.workspace}`,
      `- **Agent:** ${sanitized.agent}`,
      `- **Category:** ${sanitized.category}`,
      ...(sanitized.source ? [`- **Source:** ${sanitized.source}`] : []),
      ...(sanitized.sourceId ? [`- **Source ID:** ${sanitized.sourceId}`] : []),
      ...(sanitized.summary ? [`- **Summary:** ${sanitized.summary}`] : []),
      ...(sanitized.tags?.length
        ? [`- **Tags:** ${sanitized.tags.join(", ")}`]
        : []),
    ];
    const entryBlock = `\n### ${sanitized.date} — ${sanitized.title}\n\n${metadata.join("\n")}\n\n${sanitized.body}\n`;
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
    const blocks = content
      .split(/(?=^### \d{4}-\d{2}-\d{2} — .+$)/m)
      .slice(1);

    for (const block of blocks) {
      const header = block.split("\n")[0] ?? "";
      const match = header.match(/^### (\d{4}-\d{2}-\d{2}) — (.+)$/);
      if (!match) continue;

      const date = match[1];
      const title = match[2];
      const fields: Record<string, string> = {};
      const bodyLines: string[] = [];
      let metadataEnded = false;
      let sawMetadata = false;

      const lines = block.split("\n");
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!metadataEnded && !line.trim()) {
          if (sawMetadata) metadataEnded = true;
          continue;
        }
        const fieldMatch = !metadataEnded
          ? line.match(/^-\s+\*\*(.+?)\*\*\s*:?\s*(.*)$/)
          : null;
        if (fieldMatch) {
          fields[fieldMatch[1].replace(/:$/, "").trim()] = fieldMatch[2].trim();
          sawMetadata = true;
          continue;
        }
        metadataEnded = true;
        bodyLines.push(line);
      }

      entries.push({
        date,
        title,
        workspace: fields["Workspace"] ?? "",
        agent: fields["Agent"] ?? "",
        category: (fields["Category"] ?? "work-log") as KnowledgeEntry["category"],
        body: bodyLines.join("\n").trim(),
        ...(fields["Source"] ? { source: fields["Source"] } : {}),
        ...(fields["Source ID"] ? { sourceId: fields["Source ID"] } : {}),
        ...(fields["Summary"] ? { summary: fields["Summary"] } : {}),
        ...(fields["Tags"]
          ? {
              tags: fields["Tags"]
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            }
          : {}),
      });
    }

    return entries;
  }

  readReminders(month: string = currentMonth()): ReminderEntry[] {
    const filePath = this.remindersPath(month);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf8");
    const entries: ReminderEntry[] = [];
    const blocks = content
      .split(/(?=^### \d{4}-\d{2}-\d{2} — .+$)/m)
      .slice(1);

    for (const block of blocks) {
      const header = block.split("\n")[0] ?? "";
      const match = header.match(/^### (\d{4}-\d{2}-\d{2}) — (.+)$/);
      if (!match) continue;

      const date = match[1];
      const title = match[2];
      const fields: Record<string, string> = {};
      const actionLines: string[] = [];
      let metadataEnded = false;
      let sawMetadata = false;

      const lines = block.split("\n");
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!metadataEnded && !line.trim()) {
          if (sawMetadata) metadataEnded = true;
          continue;
        }
        const fieldMatch = !metadataEnded
          ? line.match(/^-\s+\*\*(.+?)\*\*\s*:?\s*(.*)$/)
          : null;
        if (fieldMatch) {
          fields[fieldMatch[1].replace(/:$/, "").trim()] = fieldMatch[2].trim();
          sawMetadata = true;
          continue;
        }
        metadataEnded = true;
        actionLines.push(line);
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
