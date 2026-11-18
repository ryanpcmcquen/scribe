import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { KnowledgeBase } from "./storage";

const INDEX_START = "<!-- scribe:toc:start -->";
const INDEX_END = "<!-- scribe:toc:end -->";

function tableRows(kind: "knowledge" | "reminders", storage: KnowledgeBase): string[] {
  const months = storage.listMonths(kind).reverse();
  if (months.length === 0) return ["| — | — |"];
  return months.map((month) => {
    const fileName =
      kind === "knowledge"
        ? `${month}-knowledge.md`
        : `${month}-reminders.md`;
    const relativePath = `${kind}/${month}/${fileName}`;
    return `| ${month} | [Open](./${relativePath}) |`;
  });
}

function indexBlock(storage: KnowledgeBase): string {
  const knowledgeRows = tableRows("knowledge", storage);
  const reminderRows = tableRows("reminders", storage);
  return [
    INDEX_START,
    "## Contents",
    "",
    "### Knowledge",
    "",
    "| Month | File |",
    "| --- | --- |",
    ...knowledgeRows,
    "",
    "### Reminders",
    "",
    "| Month | File |",
    "| --- | --- |",
    ...reminderRows,
    INDEX_END,
  ].join("\n");
}

function replaceManagedIndex(content: string, block: string): string {
  const start = content.indexOf(INDEX_START);
  const end = content.indexOf(INDEX_END);

  if (start === -1 && end === -1) {
    const suffix = content.endsWith("\n") ? "" : "\n";
    return `${content}${suffix}\n${block}\n`;
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Scribe README index markers are incomplete or out of order.");
  }

  const afterEnd = end + INDEX_END.length;
  return `${content.slice(0, start)}${block}${content.slice(afterEnd)}`;
}

function defaultReadme(block: string): string {
  return [
    "# Scribe Journal",
    "",
    "This is the Markdown knowledge base used by Scribe. Markdown files are the",
    "source of truth; this README is a navigation index.",
    "",
    block,
    "",
    "## Layout",
    "",
    "- Knowledge and reminders are organized into monthly folders.",
    "- New records are appended to the corresponding monthly Markdown file.",
    "- The contents section above is maintained automatically by Scribe.",
    "",
  ].join("\n");
}

/**
 * Refresh the README's managed monthly index while preserving all content
 * outside the marked section. All generated links are relative to the journal.
 */
export function updateJournalReadmeIndex(
  workspacePath: string,
  storage: KnowledgeBase,
): string {
  const readmePath = join(workspacePath, "README.md");
  const block = indexBlock(storage);
  const content = existsSync(readmePath)
    ? readFileSync(readmePath, "utf8")
    : defaultReadme(block);
  const updated = existsSync(readmePath)
    ? replaceManagedIndex(content, block)
    : content;

  if (updated !== content || !existsSync(readmePath)) {
    mkdirSync(dirname(readmePath), { recursive: true });
    const temporaryPath = `${readmePath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, updated);
    renameSync(temporaryPath, readmePath);
  }
  return readmePath;
}
