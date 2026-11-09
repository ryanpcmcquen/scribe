import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

import { resolvePath, ScribeConfig, tildifyPath } from "../config";
import { localDate } from "../date";
import { CaptureResult, Scribe } from "../scribe";
import { KnowledgeEntry } from "../storage";

const HOOK_START = "# >>> scribe post-commit >>>";
const HOOK_END = "# <<< scribe post-commit <<<";

export interface HookCaptureOutcome extends Partial<CaptureResult> {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  sha?: string;
  entry?: KnowledgeEntry;
}

export interface PostCommitHookOptions {
  repoPath?: string;
  agent?: string;
  date?: string;
}

export interface AgentStopPayload {
  title?: string;
  summary?: string;
  transcript_summary?: string;
  last_assistant_message?: string;
  message?: string;
  body?: string;
  category?: "finding" | "decision" | "work-log";
  workspace?: string;
  cwd?: string;
  repo?: string;
  agent?: string;
  date?: string;
  stop_hook_active?: boolean;
}

function runGit(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      stdio: "pipe",
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function inferCategory(
  subject: string,
  body: string,
): KnowledgeEntry["category"] {
  const combined = `${subject}\n${body}`;
  if (/\b(decide[ds]?|decision|adr|architecture|chose|chosen)\b/i.test(combined)) {
    return "decision";
  }
  if (
    /^(fix|bug|perf|security)(\([^)]+\))?:/i.test(subject) ||
    /\b(root cause|bug|regression|investigat(e|ed|ion)|discovered)\b/i.test(combined)
  ) {
    return "finding";
  }
  return "work-log";
}

function sameRealPath(a: string, b: string): boolean {
  try {
    if (!existsSync(a) || !existsSync(b)) {
      return resolve(a) === resolve(b);
    }
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/**
 * Capture the latest git commit in `repoPath` into Scribe if it has not
 * already been captured today.
 */
export async function runPostCommitHook(
  config: ScribeConfig,
  options: PostCommitHookOptions = {},
): Promise<HookCaptureOutcome> {
  const targetDir = resolvePath(options.repoPath ?? process.cwd());
  if (!existsSync(targetDir)) {
    return { ok: true, skipped: true, reason: "repository path does not exist" };
  }

  const topLevel = runGit(targetDir, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return { ok: true, skipped: true, reason: "not a git repository" };
  }

  if (sameRealPath(topLevel, config.workspace)) {
    return {
      ok: true,
      skipped: true,
      reason: "repository is the Scribe journal itself",
    };
  }

  const logOutput = runGit(topLevel, [
    "log",
    "-1",
    "--format=%H%x00%h%x00%s%x00%b",
  ]);
  if (!logOutput) {
    return { ok: true, skipped: true, reason: "repository has no commits" };
  }

  const [fullSha = "", shortSha = "", rawSubject = "", rawBody = ""] =
    logOutput.split("\0");
  const subject = rawSubject.replace(/\s+/g, " ").trim();
  if (!subject || !shortSha) {
    return { ok: true, skipped: true, reason: "commit has no subject" };
  }

  // Skip Scribe's own commit format if somehow invoked on a journal clone
  if (/^Scribe:\s*\d{4}-\d{2}-\d{2}\s+—/.test(subject)) {
    return {
      ok: true,
      skipped: true,
      reason: "commit is a Scribe journal commit",
      sha: shortSha,
    };
  }

  const date = options.date ?? localDate();
  const month = date.slice(0, 7);
  const workspaceLabel = tildifyPath(topLevel);

  const scribe = new Scribe({
    workspacePath: config.workspace,
    remote: config.remote,
    autoCommit: config.autoCommit,
    autoPush: config.autoPush,
  });

  const existing = scribe.readKnowledge(month);
  const alreadyCaptured = existing.some(
    (entry) =>
      entry.date === date &&
      entry.workspace === workspaceLabel &&
      (entry.title.toLowerCase() === subject.toLowerCase() ||
        entry.body.includes(shortSha) ||
        (fullSha !== "" && entry.body.includes(fullSha))),
  );

  if (alreadyCaptured) {
    return {
      ok: true,
      skipped: true,
      reason: "commit already captured",
      sha: shortSha,
    };
  }

  const filesOutput =
    runGit(topLevel, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      "HEAD",
    ]) ?? "";
  const files = filesOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const bodyParts: string[] = [];
  const commitBody = rawBody.trim();
  if (commitBody) {
    bodyParts.push(commitBody);
  }
  const fileSummary =
    files.length > 0
      ? files.length <= 6
        ? `Files: ${files.map((f) => `\`${f}\``).join(", ")}.`
        : `Files (${files.length}): ${files
            .slice(0, 6)
            .map((f) => `\`${f}\``)
            .join(", ")}, and ${files.length - 6} more.`
      : "";
  bodyParts.push(
    `Commit \`${shortSha}\`${fileSummary ? ` — ${fileSummary}` : "."}`,
  );

  const entry: KnowledgeEntry = {
    date,
    title: subject,
    workspace: workspaceLabel,
    agent: (options.agent ?? config.agent).trim() || config.agent,
    category: inferCategory(subject, commitBody),
    body: bodyParts.join("\n\n"),
  };

  const result = await scribe.record(entry);
  return {
    ok: true,
    skipped: Boolean(result.deduplicated),
    ...(result.deduplicated ? { reason: "duplicate entry" } : {}),
    sha: shortSha,
    entry,
    ...result,
  };
}

/**
 * Handle an agent session-stop / turn-stop hook event.
 *
 * Accepts an explicit summary/title in `payload`, or falls back to capturing
 * the latest uncaptured commit from today in the session workspace.
 */
export async function runAgentStopHook(
  config: ScribeConfig,
  payload: AgentStopPayload = {},
): Promise<HookCaptureOutcome> {
  const workspaceDir = resolvePath(
    payload.workspace ?? payload.repo ?? payload.cwd ?? process.cwd(),
  );
  const agent = (payload.agent ?? config.agent).trim() || config.agent;
  const date = payload.date ?? localDate();

  const rawSummary = (
    payload.summary ??
    payload.transcript_summary ??
    payload.body ??
    ""
  ).trim();
  const rawTitle = (payload.title ?? "").replace(/\s+/g, " ").trim();

  if (rawTitle || rawSummary) {
    const firstLine = rawSummary.split("\n")[0]?.replace(/^#+\s*/, "").trim() ?? "";
    const title =
      rawTitle ||
      (firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine) ||
      "Session checkpoint";
    const body = rawSummary || rawTitle;
    const category =
      payload.category && ["finding", "decision", "work-log"].includes(payload.category)
        ? payload.category
        : inferCategory(title, body);

    const scribe = new Scribe({
      workspacePath: config.workspace,
      remote: config.remote,
      autoCommit: config.autoCommit,
      autoPush: config.autoPush,
    });

    const entry: KnowledgeEntry = {
      date,
      title,
      workspace: tildifyPath(workspaceDir),
      agent,
      category,
      body,
    };

    const result = await scribe.record(entry);
    return {
      ok: true,
      skipped: Boolean(result.deduplicated),
      ...(result.deduplicated ? { reason: "duplicate entry" } : {}),
      entry,
      ...result,
    };
  }

  // Fallback: if a commit was authored on `date` in `workspaceDir`, capture it.
  const commitDate = runGit(workspaceDir, ["log", "-1", "--format=%cd", "--date=short"]);
  if (commitDate === date) {
    return runPostCommitHook(config, {
      repoPath: workspaceDir,
      agent,
      date,
    });
  }

  return {
    ok: true,
    skipped: true,
    reason: "no summary provided and no new commit today",
  };
}

function resolveGitHookFile(repoPath: string): string {
  const targetDir = resolvePath(repoPath);
  const relHookPath = runGit(targetDir, ["rev-parse", "--git-path", "hooks/post-commit"]);
  if (!relHookPath) {
    throw new Error(`not a git repository: ${targetDir}`);
  }
  return resolvePath(relHookPath, targetDir);
}

export interface GitHookInstallResult {
  installed: boolean;
  hookPath: string;
}

export function installGitHook(
  repoPath: string = process.cwd(),
  cliCommand = "scribe",
): GitHookInstallResult {
  const hookPath = resolveGitHookFile(repoPath);
  mkdirSync(dirname(hookPath), { recursive: true });

  const block = [
    HOOK_START,
    `${cliCommand} hook post-commit --repo "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || true`,
    HOOK_END,
  ].join("\n");

  let existing = "";
  if (existsSync(hookPath)) {
    existing = readFileSync(hookPath, "utf8");
    const startIdx = existing.indexOf(HOOK_START);
    const endIdx = existing.indexOf(HOOK_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const updated =
        existing.slice(0, startIdx) +
        block +
        existing.slice(endIdx + HOOK_END.length);
      writeFileSync(hookPath, updated);
      chmodSync(hookPath, 0o755);
      return { installed: true, hookPath };
    }
  }

  const prefix = existing
    ? existing.endsWith("\n")
      ? existing
      : `${existing}\n`
    : "#!/bin/sh\n";
  writeFileSync(hookPath, `${prefix}\n${block}\n`);
  chmodSync(hookPath, 0o755);
  return { installed: true, hookPath };
}

export function uninstallGitHook(
  repoPath: string = process.cwd(),
): { removed: boolean; hookPath: string } {
  const hookPath = resolveGitHookFile(repoPath);
  if (!existsSync(hookPath)) {
    return { removed: false, hookPath };
  }

  const existing = readFileSync(hookPath, "utf8");
  const startIdx = existing.indexOf(HOOK_START);
  const endIdx = existing.indexOf(HOOK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { removed: false, hookPath };
  }

  const remaining = (
    existing.slice(0, startIdx) + existing.slice(endIdx + HOOK_END.length)
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!remaining || remaining === "#!/bin/sh" || remaining === "#!/usr/bin/env sh") {
    rmSync(hookPath, { force: true });
  } else {
    writeFileSync(hookPath, `${remaining}\n`);
  }

  return { removed: true, hookPath };
}

export function gitHookStatus(
  repoPath: string = process.cwd(),
): { installed: boolean; hookPath: string } {
  const hookPath = resolveGitHookFile(repoPath);
  if (!existsSync(hookPath)) {
    return { installed: false, hookPath };
  }
  const content = readFileSync(hookPath, "utf8");
  return {
    installed: content.includes(HOOK_START) && content.includes(HOOK_END),
    hookPath,
  };
}

export interface DiscoveredRepoHookStatus {
  repo: string;
  installed?: boolean;
  removed?: boolean;
  hookPath: string;
}

/**
 * Recursively discover git repositories under `rootDir` up to `maxDepth`,
 * skipping the Scribe journal workspace itself.
 */
export function discoverGitRepos(
  rootDir: string,
  options: { maxDepth?: number; skipWorkspace?: string } = {},
): string[] {
  const resolvedRoot = resolvePath(rootDir);
  if (!existsSync(resolvedRoot)) {
    throw new Error(`scan directory does not exist: ${resolvedRoot}`);
  }

  const maxDepth = options.maxDepth ?? 2;
  const found = new Set<string>();

  function walk(currentDir: string, depth: number): void {
    if (
      options.skipWorkspace &&
      sameRealPath(currentDir, options.skipWorkspace)
    ) {
      return;
    }

    if (existsSync(join(currentDir, ".git"))) {
      const topLevel = runGit(currentDir, ["rev-parse", "--show-toplevel"]);
      if (
        topLevel &&
        (!options.skipWorkspace ||
          !sameRealPath(topLevel, options.skipWorkspace))
      ) {
        found.add(resolvePath(topLevel));
      }
      return;
    }

    if (depth >= maxDepth) {
      return;
    }

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "dist"
      ) {
        continue;
      }
      walk(join(currentDir, entry.name), depth + 1);
    }
  }

  walk(resolvedRoot, 0);
  return [...found].sort();
}

export function installGitHooksInDir(
  rootDir: string,
  options: {
    maxDepth?: number;
    skipWorkspace?: string;
    cliCommand?: string;
  } = {},
): DiscoveredRepoHookStatus[] {
  const repos = discoverGitRepos(rootDir, options);
  return repos.map((repo) => ({
    repo: tildifyPath(repo),
    ...installGitHook(repo, options.cliCommand),
  }));
}

export function uninstallGitHooksInDir(
  rootDir: string,
  options: { maxDepth?: number; skipWorkspace?: string } = {},
): DiscoveredRepoHookStatus[] {
  const repos = discoverGitRepos(rootDir, options);
  return repos.map((repo) => ({
    repo: tildifyPath(repo),
    ...uninstallGitHook(repo),
  }));
}

export function gitHooksStatusInDir(
  rootDir: string,
  options: { maxDepth?: number; skipWorkspace?: string } = {},
): DiscoveredRepoHookStatus[] {
  const repos = discoverGitRepos(rootDir, options);
  return repos.map((repo) => ({
    repo: tildifyPath(repo),
    ...gitHookStatus(repo),
  }));
}

export type AgentSkillTarget =
  | "opencode"
  | "claude-code"
  | "codex"
  | "cline"
  | "antigravity";

export const ALL_SKILL_AGENTS: AgentSkillTarget[] = [
  "opencode",
  "claude-code",
  "codex",
  "cline",
  "antigravity",
];

export interface AgentSkillInstallResult {
  agent: AgentSkillTarget;
  installed: boolean;
  skillPath: string;
}

function targetSkillPathForAgent(
  agent: AgentSkillTarget,
  homeDir: string,
  configHome: string,
): string {
  switch (agent) {
    case "opencode":
      return join(
        resolvePath(configHome),
        "opencode",
        "skills",
        "scribe-capture",
        "SKILL.md",
      );
    case "claude-code":
      return join(
        resolvePath(homeDir),
        ".claude",
        "skills",
        "scribe-capture",
        "SKILL.md",
      );
    case "codex":
      return join(
        resolvePath(homeDir),
        ".codex",
        "skills",
        "scribe-capture",
        "SKILL.md",
      );
    case "cline":
      return join(
        resolvePath(homeDir),
        ".cline",
        "skills",
        "scribe-capture",
        "SKILL.md",
      );
    case "antigravity":
      return join(
        resolvePath(homeDir),
        ".antigravity",
        "skills",
        "scribe-capture",
        "SKILL.md",
      );
  }
}

export function installAgentSkills(
  options: {
    agents?: AgentSkillTarget[];
    homeDir?: string;
    configHome?: string;
  } = {},
): AgentSkillInstallResult[] {
  const homeDir = options.homeDir ?? homedir();
  const configHome =
    options.configHome ??
    process.env.XDG_CONFIG_HOME ??
    join(homeDir, ".config");
  const agents = options.agents ?? ALL_SKILL_AGENTS;

  return agents.map((agent) => {
    const sourceSkill = join(
      __dirname,
      "..",
      "..",
      "skills",
      agent,
      "scribe-capture.md",
    );
    if (!existsSync(sourceSkill)) {
      throw new Error(`Skill template for ${agent} not found at ${sourceSkill}`);
    }
    const targetSkill = targetSkillPathForAgent(agent, homeDir, configHome);
    mkdirSync(dirname(targetSkill), { recursive: true });
    writeFileSync(targetSkill, readFileSync(sourceSkill, "utf8"));
    return {
      agent,
      installed: true,
      skillPath: targetSkill,
    };
  });
}

export function installOpenCodeSkill(
  configHome: string = process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
): { installed: boolean; skillPath: string } {
  const [result] = installAgentSkills({
    agents: ["opencode"],
    configHome,
  });
  return {
    installed: result.installed,
    skillPath: result.skillPath,
  };
}
