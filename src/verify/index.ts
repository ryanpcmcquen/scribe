import { execFileSync } from "child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import { extname, join, relative, sep } from "path";
import { isDate, isMonth } from "../date";
import { redactSecrets } from "../storage";

export type VerifyIssueKind = "secret" | "malformed";

export interface VerifyIssue {
  kind: VerifyIssueKind;
  path: string;
  line: number;
  message: string;
  commit?: string;
}

export interface VerifyOptions {
  history?: boolean;
  redactionLiterals?: readonly string[];
}

export interface VerifyReport {
  ok: boolean;
  workspace: string;
  filesScanned: number;
  entriesScanned: number;
  historyCommitsScanned: number;
  historyFilesScanned: number;
  secretFindings: number;
  malformedFindings: number;
  issues: VerifyIssue[];
}

type StorageKind = "knowledge" | "reminders";

interface EntryRange {
  start: number;
  end: number;
  heading: string;
}

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const FIELD_LINE = /^-\s+\*\*(.+?)\*\*\s*:?\s*(.*)$/;

function normalizeRelativePath(
  path: string,
  redactionLiterals: readonly string[] = [],
): string {
  return redactSecrets(path.split(sep).join("/"), redactionLiterals);
}

function entryRanges(lines: string[]): EntryRange[] {
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^### \d{4}-\d{2}-\d{2} — .+$/.test(lines[index])) {
      starts.push(index);
    }
  }

  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? lines.length,
    heading: lines[start].slice(4),
  }));
}

function addIssue(
  issues: VerifyIssue[],
  issue: VerifyIssue,
): void {
  issues.push(issue);
}

function scanSecrets(
  content: string,
  path: string,
  issues: VerifyIssue[],
  redactionLiterals: readonly string[] = [],
  commit?: string,
): void {
  const lines = content.split("\n");
  let insidePrivateKey = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const beginsPrivateKey = PRIVATE_KEY_BEGIN.test(line);
    const endsPrivateKey = PRIVATE_KEY_END.test(line);
    const redacted = redactSecrets(line, redactionLiterals) !== line;

    if (redacted || beginsPrivateKey || insidePrivateKey) {
      addIssue(issues, {
        kind: "secret",
        path,
        line: index + 1,
        message: "Potential secret-like value detected; inspect locally.",
        ...(commit ? { commit } : {}),
      });
    }

    if (beginsPrivateKey) {
      insidePrivateKey = !endsPrivateKey;
    } else if (endsPrivateKey) {
      insidePrivateKey = false;
    }
  }
}

function inspectFields(
  lines: string[],
  range: EntryRange,
  kind: StorageKind,
  path: string,
  issues: VerifyIssue[],
): void {
  const fields = new Map<string, { value: string; line: number }>();
  let metadataEnded = false;
  let sawMetadata = false;

  for (let index = range.start + 1; index < range.end; index++) {
    const line = lines[index];
    if (!metadataEnded && !line.trim()) {
      if (sawMetadata) metadataEnded = true;
      continue;
    }
    const match = !metadataEnded ? line.match(FIELD_LINE) : null;
    if (!match) {
      metadataEnded = true;
      continue;
    }

    const name = match[1].replace(/:$/, "").trim();
    if (fields.has(name)) {
      addIssue(issues, {
        kind: "malformed",
        path,
        line: index + 1,
        message: `Duplicate entry field: ${name}.`,
      });
      continue;
    }
    fields.set(name, { value: match[2].trim(), line: index + 1 });
    sawMetadata = true;
  }

  const required =
    kind === "knowledge"
      ? ["Workspace", "Agent", "Category"]
      : ["Priority", "Context"];

  for (const name of required) {
    if (!fields.has(name)) {
      addIssue(issues, {
        kind: "malformed",
        path,
        line: range.start + 1,
        message: `Entry is missing required field: ${name}.`,
      });
    }
  }

  if (kind === "knowledge") {
    const category = fields.get("Category");
    if (
      category &&
      !["finding", "decision", "work-log"].includes(category.value)
    ) {
      addIssue(issues, {
        kind: "malformed",
        path,
        line: category.line,
        message: "Knowledge category must be finding, decision, or work-log.",
      });
    }
    return;
  }

  const priority = fields.get("Priority");
  if (priority && !["p1", "p2", "p3"].includes(priority.value)) {
    addIssue(issues, {
      kind: "malformed",
      path,
      line: priority.line,
      message: "Reminder priority must be p1, p2, or p3.",
    });
  }

  const status = fields.get("Status");
  if (status && !["pending", "done", "snoozed"].includes(status.value)) {
    addIssue(issues, {
      kind: "malformed",
      path,
      line: status.line,
      message: "Reminder status must be pending, done, or snoozed.",
    });
  }

  const snoozedUntil = fields.get("Snoozed Until");
  if (snoozedUntil && !isDate(snoozedUntil.value)) {
    addIssue(issues, {
      kind: "malformed",
      path,
      line: snoozedUntil.line,
      message: "Snoozed Until must be a valid YYYY-MM-DD date.",
    });
  }
  if (status?.value === "snoozed" && !snoozedUntil) {
    addIssue(issues, {
      kind: "malformed",
      path,
      line: status.line,
      message: "Snoozed reminders require a Snoozed Until date.",
    });
  }

  const completedAt = fields.get("Completed");
  if (completedAt && !isDate(completedAt.value)) {
    addIssue(issues, {
      kind: "malformed",
      path,
      line: completedAt.line,
      message: "Completed must be a valid YYYY-MM-DD date.",
    });
  }
}

function inspectMarkdownFile(
  filePath: string,
  workspacePath: string,
  kind: StorageKind,
  expectedMonth: string | undefined,
  issues: VerifyIssue[],
  redactionLiterals: readonly string[] = [],
): number {
  const path = normalizeRelativePath(
    relative(workspacePath, filePath),
    redactionLiterals,
  );
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    addIssue(issues, {
      kind: "malformed",
      path,
      line: 1,
      message: "Could not read markdown file.",
    });
    return 0;
  }

  scanSecrets(content, path, issues, redactionLiterals);

  const lines = content.replace(/^\uFEFF/, "").split("\n");
  const monthHeader = lines[0]?.match(/^## (\d{4}-\d{2})\s*$/);
  if (!monthHeader || !isMonth(monthHeader[1])) {
    addIssue(issues, {
      kind: "malformed",
      path,
      line: 1,
      message: "File must start with a valid ## YYYY-MM month heading.",
    });
  } else if (expectedMonth && monthHeader[1] !== expectedMonth) {
    addIssue(issues, {
      kind: "malformed",
      path,
      line: 1,
      message: `Month heading does not match containing folder ${expectedMonth}.`,
    });
  }

  const ranges = entryRanges(lines);
  if (ranges.length === 0) {
    const trailingContent = lines
      .slice(1)
      .some((line) => line.trim().length > 0);
    if (trailingContent) {
      addIssue(issues, {
        kind: "malformed",
        path,
        line: 2,
        message: "Found content outside an entry heading.",
      });
    }
    return 0;
  }

  const preambleLines = lines.slice(1, ranges[0].start);
  const hasPreamble = preambleLines.some((line) => line.trim().length > 0);
  if (hasPreamble) {
    addIssue(issues, {
      kind: "malformed",
      path,
      line: 2,
      message: "Found content outside an entry heading.",
    });
  }

  for (const range of ranges) {
    const heading = range.heading.match(/^(\d{4}-\d{2}-\d{2}) — (.+)$/);
    if (!heading) {
      addIssue(issues, {
        kind: "malformed",
        path,
        line: range.start + 1,
        message: "Entry heading must match ### YYYY-MM-DD — title.",
      });
      continue;
    }

    const date = heading[1];
    const title = heading[2].trim();
    if (!isDate(date)) {
      addIssue(issues, {
        kind: "malformed",
        path,
        line: range.start + 1,
        message: "Entry heading contains an invalid calendar date.",
      });
    }
    if (!title) {
      addIssue(issues, {
        kind: "malformed",
        path,
        line: range.start + 1,
        message: "Entry heading title must not be empty.",
      });
    }
    if (expectedMonth && date.slice(0, 7) !== expectedMonth) {
      addIssue(issues, {
        kind: "malformed",
        path,
        line: range.start + 1,
        message: `Entry date does not match containing folder ${expectedMonth}.`,
      });
    }

    inspectFields(lines, range, kind, path, issues);
  }

  return ranges.length;
}

function walkStorageDirectory(
  directory: string,
  workspacePath: string,
  kind: StorageKind,
  expectedMonth: string | undefined,
  issues: VerifyIssue[],
  redactionLiterals: readonly string[] = [],
): { files: number; entries: number } {
  let children;
  try {
    children = readdirSync(directory, { withFileTypes: true });
  } catch {
    addIssue(issues, {
      kind: "malformed",
      path: normalizeRelativePath(
        relative(workspacePath, directory),
        redactionLiterals,
      ),
      line: 1,
      message: "Could not list storage directory.",
    });
    return { files: 0, entries: 0 };
  }

  let files = 0;
  let entries = 0;
  for (const child of children) {
    const childPath = join(directory, child.name);
    if (child.isDirectory()) {
      addIssue(issues, {
        kind: "malformed",
        path: normalizeRelativePath(
          relative(workspacePath, childPath),
          redactionLiterals,
        ),
        line: 1,
        message: "Unexpected nested directory in monthly storage.",
      });
      const nested = walkStorageDirectory(
        childPath,
        workspacePath,
        kind,
        expectedMonth,
        issues,
        redactionLiterals,
      );
      files += nested.files;
      entries += nested.entries;
      continue;
    }

    if (!child.isFile() || extname(child.name).toLowerCase() !== ".md") {
      continue;
    }

    const expectedName = expectedMonth
      ? `${expectedMonth}-${kind === "knowledge" ? "knowledge" : "reminders"}.md`
      : undefined;
    if (expectedName && child.name !== expectedName) {
      addIssue(issues, {
        kind: "malformed",
        path: normalizeRelativePath(
          relative(workspacePath, childPath),
          redactionLiterals,
        ),
        line: 1,
        message: `Expected monthly filename ${expectedName}.`,
      });
    }

    files++;
    entries += inspectMarkdownFile(
      childPath,
      workspacePath,
      kind,
      expectedMonth,
      issues,
      redactionLiterals,
    );
  }

  return { files, entries };
}

function inspectStorageRoot(
  workspacePath: string,
  kind: StorageKind,
  issues: VerifyIssue[],
  redactionLiterals: readonly string[],
): { files: number; entries: number } {
  const root = join(workspacePath, kind);
  if (!existsSync(root)) return { files: 0, entries: 0 };

  let children;
  try {
    children = readdirSync(root, { withFileTypes: true });
  } catch {
    addIssue(issues, {
      kind: "malformed",
      path: kind,
      line: 1,
      message: "Could not list storage root.",
    });
    return { files: 0, entries: 0 };
  }

  let files = 0;
  let entries = 0;
  for (const child of children) {
    const childPath = join(root, child.name);
    if (child.isDirectory()) {
      if (!isMonth(child.name)) {
        addIssue(issues, {
          kind: "malformed",
          path: normalizeRelativePath(
            relative(workspacePath, childPath),
            redactionLiterals,
          ),
          line: 1,
          message: "Storage directory must be named YYYY-MM.",
        });
      } else {
        const expectedFile = join(
          childPath,
          `${child.name}-${kind === "knowledge" ? "knowledge" : "reminders"}.md`,
        );
        if (!existsSync(expectedFile)) {
          addIssue(issues, {
            kind: "malformed",
            path: normalizeRelativePath(
              relative(workspacePath, expectedFile),
              redactionLiterals,
            ),
            line: 1,
            message: "Expected monthly markdown file is missing.",
          });
        }
      }

      const scanned = walkStorageDirectory(
        childPath,
        workspacePath,
        kind,
        isMonth(child.name) ? child.name : undefined,
        issues,
        redactionLiterals,
      );
      files += scanned.files;
      entries += scanned.entries;
      continue;
    }

    if (child.isFile() && extname(child.name).toLowerCase() === ".md") {
      const path = normalizeRelativePath(
        relative(workspacePath, childPath),
        redactionLiterals,
      );
      addIssue(issues, {
        kind: "malformed",
        path,
        line: 1,
        message: "Markdown files must be inside a YYYY-MM storage directory.",
      });
      files++;
      entries += inspectMarkdownFile(
        childPath,
        workspacePath,
        kind,
        undefined,
        issues,
        redactionLiterals,
      );
    }
  }

  return { files, entries };
}

function gitOutput(
  workspacePath: string,
  args: string[],
  trimOutput = true,
): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd: workspacePath,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: "pipe",
    });
    return trimOutput ? output.trim() : output;
  } catch {
    return undefined;
  }
}

function scanGitHistory(
  workspacePath: string,
  issues: VerifyIssue[],
  redactionLiterals: readonly string[],
): { commits: number; files: number } {
  if (gitOutput(workspacePath, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    addIssue(issues, {
      kind: "malformed",
      path: ".",
      line: 1,
      message: "Git history scan requires a journal Git repository.",
    });
    return { commits: 0, files: 0 };
  }

  const log = gitOutput(workspacePath, [
    "log",
    "--all",
    "--format=%H",
    "--name-only",
    "--diff-filter=ACMRT",
    "--",
    "knowledge",
    "reminders",
  ]);
  if (log === undefined) {
    addIssue(issues, {
      kind: "malformed",
      path: ".",
      line: 1,
      message: "Could not read reachable Git history.",
    });
    return { commits: 0, files: 0 };
  }

  const revisions: Array<{ commit: string; path: string }> = [];
  let currentCommit: string | undefined;
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^[0-9a-f]{40,64}$/i.test(line)) {
      currentCommit = line;
      continue;
    }
    if (currentCommit && /^(knowledge|reminders)\/.+\.md$/i.test(line)) {
      revisions.push({ commit: currentCommit, path: line });
    }
  }

  let files = 0;
  const commits = new Set<string>();
  for (const revision of revisions) {
    const content = gitOutput(
      workspacePath,
      ["show", `${revision.commit}:${revision.path}`],
      false,
    );
    if (content === undefined) continue;

    files++;
    commits.add(revision.commit);
    const path = normalizeRelativePath(revision.path, redactionLiterals);
    scanSecrets(
      content,
      path,
      issues,
      redactionLiterals,
      revision.commit.slice(0, 12),
    );
  }

  return { commits: commits.size, files };
}

export function verifyJournal(
  workspacePath: string,
  options: VerifyOptions = {},
): VerifyReport {
  const absoluteWorkspace = workspacePath;
  const issues: VerifyIssue[] = [];
  const redactionLiterals = options.redactionLiterals ?? [];

  if (!existsSync(absoluteWorkspace)) {
    addIssue(issues, {
      kind: "malformed",
      path: ".",
      line: 1,
      message: "Journal workspace does not exist.",
    });
  } else if (!statSync(absoluteWorkspace).isDirectory()) {
    addIssue(issues, {
      kind: "malformed",
      path: ".",
      line: 1,
      message: "Journal workspace is not a directory.",
    });
  } else {
    for (const kind of ["knowledge", "reminders"] as const) {
      const root = join(absoluteWorkspace, kind);
      if (existsSync(root) && !statSync(root).isDirectory()) {
        addIssue(issues, {
          kind: "malformed",
          path: kind,
          line: 1,
          message: "Storage root must be a directory.",
        });
        continue;
      }
    }
  }

  let filesScanned = 0;
  let entriesScanned = 0;
  if (existsSync(absoluteWorkspace) && statSync(absoluteWorkspace).isDirectory()) {
    for (const kind of ["knowledge", "reminders"] as const) {
      const root = join(absoluteWorkspace, kind);
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
      const scanned = inspectStorageRoot(
        absoluteWorkspace,
        kind,
        issues,
        redactionLiterals,
      );
      filesScanned += scanned.files;
      entriesScanned += scanned.entries;
    }
  }

  const historyResult =
    options.history &&
    existsSync(absoluteWorkspace) &&
    statSync(absoluteWorkspace).isDirectory()
      ? scanGitHistory(absoluteWorkspace, issues, redactionLiterals)
      : { commits: 0, files: 0 };

  for (const issue of issues) {
    issue.message = redactSecrets(issue.message, redactionLiterals);
  }

  issues.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.kind.localeCompare(b.kind),
  );
  const secretFindings = issues.filter((issue) => issue.kind === "secret").length;
  const malformedFindings = issues.filter(
    (issue) => issue.kind === "malformed",
  ).length;

  return {
    ok: issues.length === 0,
    workspace: absoluteWorkspace,
    filesScanned,
    entriesScanned,
    historyCommitsScanned: historyResult.commits,
    historyFilesScanned: historyResult.files,
    secretFindings,
    malformedFindings,
    issues,
  };
}
