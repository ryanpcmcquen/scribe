#!/usr/bin/env node
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

import {
  ConfigOverrides,
  defaultConfigPath,
  loadConfig,
  resolvePath,
  saveConfig,
  ScribeConfig,
  tildifyPath,
} from "./config";
import { currentMonth, isDate, isMonth, localDate } from "./date";
import { Git, isRemoteTarget } from "./git";
import {
  AgentStopPayload,
  gitHookStatus,
  installGitHook,
  installOpenCodeSkill,
  runAgentStopHook,
  runPostCommitHook,
  uninstallGitHook,
} from "./hooks";
import { runMcpServer } from "./mcp";
import { FocusItem } from "./merge";
import { Scribe } from "./scribe";
import { KnowledgeEntry, ReminderEntry, ScribeEntry } from "./storage";

type FlagValue = string | boolean;

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, FlagValue>;
}

interface CaptureInput {
  type?: string;
  date?: string;
  title?: string;
  workspace?: string;
  agent?: string;
  category?: string;
  body?: string;
  priority?: string;
  context?: string;
  action?: string;
}

const BOOLEAN_FLAGS = new Set([
  "all",
  "dry-run",
  "force",
  "git",
  "help",
  "json",
  "no-commit",
  "no-git",
  "no-push",
  "skills",
  "stdin",
  "version",
]);

function parseArgv(argv: string[]): ParsedArgs {
  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const equalsIndex = withoutPrefix.indexOf("=");
      const name =
        equalsIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalsIndex);
      const inlineValue =
        equalsIndex === -1 ? undefined : withoutPrefix.slice(equalsIndex + 1);

      if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(name, next);
          index++;
        } else {
          flags.set(name, true);
        }
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      flags.set(arg.slice(1), true);
      continue;
    }

    positionals.push(arg);
  }

  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

function flagString(
  flags: Map<string, FlagValue>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value === "boolean") {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function flagBool(flags: Map<string, FlagValue>, name: string): boolean {
  return flags.get(name) === true;
}

function configOverrides(args: ParsedArgs): ConfigOverrides {
  const overrides: ConfigOverrides = {};

  const workspace = flagString(args.flags, "workspace");
  if (workspace !== undefined) overrides.workspace = workspace;

  const remote = flagString(args.flags, "remote");
  if (remote !== undefined) overrides.remote = remote;

  const agent = flagString(args.flags, "agent");
  if (agent !== undefined) overrides.agent = agent;

  if (flagBool(args.flags, "no-commit")) overrides.autoCommit = false;
  if (flagBool(args.flags, "no-push")) overrides.autoPush = false;

  return overrides;
}

function configPathFrom(args: ParsedArgs): string {
  const explicit = flagString(args.flags, "config");
  return resolvePath(
    explicit ?? process.env.SCRIBE_CONFIG ?? defaultConfigPath(),
  );
}

function captureInputFromFlags(args: ParsedArgs): CaptureInput {
  return {
    type: flagString(args.flags, "type"),
    date: flagString(args.flags, "date"),
    title: flagString(args.flags, "title"),
    workspace: flagString(args.flags, "repo"),
    agent: flagString(args.flags, "agent"),
    category: flagString(args.flags, "category"),
    body: flagString(args.flags, "body"),
    priority: flagString(args.flags, "priority"),
    context: flagString(args.flags, "context"),
    action: flagString(args.flags, "action"),
  };
}

function mergeInputs(base: CaptureInput, overrides: CaptureInput): CaptureInput {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined),
    ),
  } as CaptureInput;
}

function buildEntry(input: CaptureInput, config: ScribeConfig): ScribeEntry {
  const date = input.date ?? localDate();
  if (!isDate(date)) {
    throw new Error(`invalid date "${date}" (expected YYYY-MM-DD)`);
  }

  const title = (input.title ?? "").replace(/\s+/g, " ").trim();
  if (!title) {
    throw new Error("a title is required");
  }

  const inferredReminder =
    input.priority !== undefined ||
    input.context !== undefined ||
    input.action !== undefined;
  const kind = input.type ?? (inferredReminder ? "reminder" : "knowledge");

  if (kind !== "knowledge" && kind !== "reminder") {
    throw new Error(`invalid type "${kind}" (expected knowledge or reminder)`);
  }

  if (kind === "reminder") {
    const priority = input.priority ?? "p2";
    if (!["p1", "p2", "p3"].includes(priority)) {
      throw new Error(`invalid priority "${priority}" (expected p1, p2, or p3)`);
    }
    return {
      date,
      title,
      priority: priority as ReminderEntry["priority"],
      context: input.context ?? "",
      action: input.action ?? input.body ?? "",
    };
  }

  const category = input.category ?? "work-log";
  if (!["finding", "decision", "work-log"].includes(category)) {
    throw new Error(
      `invalid category "${category}" (expected finding, decision, or work-log)`,
    );
  }

  const workspace = input.workspace ?? process.cwd();
  return {
    date,
    title,
    workspace: tildifyPath(resolvePath(workspace)),
    agent: (input.agent ?? config.agent).trim() || config.agent,
    category: category as KnowledgeEntry["category"],
    body: input.body ?? "",
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseStdinInput(raw: string): CaptureInput {
  if (!raw.trim()) {
    throw new Error("no JSON input received on stdin");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON on stdin: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stdin JSON must be an object");
  }

  return parsed as CaptureInput;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printConfig(config: ScribeConfig, configPath: string): void {
  console.log(`config: ${configPath}`);
  console.log(`workspace: ${tildifyPath(config.workspace)}`);
  console.log(`agent: ${config.agent}`);
  console.log(`autoCommit: ${config.autoCommit}`);
  console.log(`autoPush: ${config.autoPush}`);
  console.log(`remote: ${config.remote ?? "(auto)"}`);
}

function printKnowledgeEntries(entries: KnowledgeEntry[]): void {
  if (entries.length === 0) {
    console.log("No knowledge entries.");
    return;
  }

  for (const entry of entries) {
    console.log(`\n${entry.date} — ${entry.title} [${entry.category}]`);
    console.log(`  workspace: ${entry.workspace || "(unknown)"}`);
    console.log(`  agent: ${entry.agent || "(unknown)"}`);
    if (entry.body) {
      console.log(`  ${entry.body.replace(/\n/g, "\n  ")}`);
    }
  }
}

function printReminderEntries(entries: ReminderEntry[]): void {
  if (entries.length === 0) {
    console.log("No reminders.");
    return;
  }

  for (const entry of entries) {
    console.log(`\n${entry.date} — ${entry.title} [${entry.priority}]`);
    if (entry.context) console.log(`  context: ${entry.context}`);
    if (entry.action) console.log(`  action: ${entry.action.replace(/\n/g, "\n  ")}`);
  }
}

function printFocus(items: FocusItem[]): void {
  if (items.length === 0) {
    console.log("No focus items.");
    return;
  }

  for (const item of items) {
    console.log(
      `\n${item.score}  ${item.entry.date} — ${item.entry.title} [${item.entry.category}]`,
    );
    if (item.entry.workspace) console.log(`   ${item.entry.workspace}`);
  }
}

function isGitRepo(path: string): boolean {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: path,
      stdio: "pipe",
    })
      .toString()
      .trim();
    return realpathSync(top) === realpathSync(path);
  } catch {
    return false;
  }
}

function ensureGitRepo(path: string): boolean {
  if (isGitRepo(path)) return false;
  execFileSync("git", ["init", "-b", "main"], {
    cwd: path,
    stdio: "pipe",
  });
  return true;
}

function ensureMonthFiles(workspace: string, month: string): void {
  const files = [
    join(workspace, "knowledge", month, `${month}-knowledge.md`),
    join(workspace, "reminders", month, `${month}-reminders.md`),
  ];

  for (const file of files) {
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `## ${month}\n`);
  }
}

function commandInit(
  args: ParsedArgs,
  config: ScribeConfig,
  configPath: string,
): number {
  const json = flagBool(args.flags, "json");
  const force = flagBool(args.flags, "force");
  const noGit = flagBool(args.flags, "no-git");

  const configExisted = existsSync(configPath);
  const configCreated = !configExisted || force;

  mkdirSync(config.workspace, { recursive: true });
  const gitInitialized = noGit ? false : ensureGitRepo(config.workspace);

  const gitignorePath = join(config.workspace, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, ".DS_Store\n");
  }

  const month = currentMonth();
  ensureMonthFiles(config.workspace, month);

  if (configCreated) {
    saveConfig(config, configPath);
  }

  const result = {
    ok: true,
    configPath,
    workspace: config.workspace,
    configCreated,
    configExisted,
    gitInitialized,
    month,
  };

  if (json) {
    printJson(result);
  } else {
    console.log(`Scribe initialized.`);
    console.log(`  workspace: ${tildifyPath(config.workspace)}`);
    console.log(`  config: ${configPath}${configExisted && !force ? " (kept)" : ""}`);
    console.log(`  git: ${noGit ? "skipped" : gitInitialized ? "initialized" : "already a repo"}`);
    console.log(`  month: ${month}`);
  }

  return 0;
}

async function commandCapture(
  args: ParsedArgs,
  config: ScribeConfig,
): Promise<number> {
  const json = flagBool(args.flags, "json");
  const dryRun = flagBool(args.flags, "dry-run");
  const useStdin = flagBool(args.flags, "stdin");

  const flagInput = captureInputFromFlags(args);
  const input = useStdin
    ? mergeInputs(parseStdinInput(await readStdin()), flagInput)
    : flagInput;

  const entry = buildEntry(input, config);
  const scribe = new Scribe({
    workspacePath: config.workspace,
    remote: config.remote,
    autoCommit: config.autoCommit,
    autoPush: config.autoPush,
  });

  const target = scribe.pathFor(entry);
  if (dryRun) {
    const result = { ok: true, dryRun: true, entry, path: target };
    if (json) printJson(result);
    else {
      console.log(`Would capture ${"category" in entry ? "knowledge" : "reminder"}: ${entry.title}`);
      console.log(`  ${target}`);
    }
    return 0;
  }

  const result = await scribe.record(entry);
  if (json) {
    printJson({ ok: true, entry, ...result });
  } else {
    console.log(
      `Captured ${"category" in entry ? "knowledge" : "reminder"}: ${entry.title}`,
    );
    console.log(`  ${result.path}`);
    console.log(`  committed: ${result.committed ? "yes" : "no"}`);
    console.log(
      `  pushed: ${result.pushed ? "yes" : "no"}${result.pushError ? ` (${result.pushError})` : ""}`,
    );
  }

  return 0;
}

function commandRead(args: ParsedArgs, config: ScribeConfig): number {
  const json = flagBool(args.flags, "json");
  const all = flagBool(args.flags, "all");
  const month = flagString(args.flags, "month");
  const repoFilter = flagString(args.flags, "repo");

  if (all && month) {
    throw new Error("use either --month or --all, not both");
  }
  if (month && !isMonth(month)) {
    throw new Error(`invalid month "${month}" (expected YYYY-MM)`);
  }

  const scribe = new Scribe({
    workspacePath: config.workspace,
    autoCommit: false,
    autoPush: false,
  });
  let entries = all ? scribe.readAllKnowledge() : scribe.readKnowledge(month);
  if (repoFilter) {
    const normalizedRepo = tildifyPath(resolvePath(repoFilter));
    entries = entries.filter((entry) => entry.workspace === normalizedRepo);
  }

  if (json) {
    printJson({ ok: true, month: all ? null : month ?? currentMonth(), entries });
  } else {
    printKnowledgeEntries(entries);
  }

  return 0;
}

function commandReminders(args: ParsedArgs, config: ScribeConfig): number {
  const json = flagBool(args.flags, "json");
  const all = flagBool(args.flags, "all");
  const month = flagString(args.flags, "month");

  if (all && month) {
    throw new Error("use either --month or --all, not both");
  }
  if (month && !isMonth(month)) {
    throw new Error(`invalid month "${month}" (expected YYYY-MM)`);
  }

  const scribe = new Scribe({
    workspacePath: config.workspace,
    autoCommit: false,
    autoPush: false,
  });
  const entries = all ? scribe.readAllReminders() : scribe.readReminders(month);

  if (json) {
    printJson({ ok: true, month: all ? null : month ?? currentMonth(), entries });
  } else {
    printReminderEntries(entries);
  }

  return 0;
}

function commandFocus(args: ParsedArgs, config: ScribeConfig): number {
  const json = flagBool(args.flags, "json");
  const all = flagBool(args.flags, "all");
  const month = flagString(args.flags, "month");

  if (all && month) {
    throw new Error("use either --month or --all, not both");
  }
  if (month && !isMonth(month)) {
    throw new Error(`invalid month "${month}" (expected YYYY-MM)`);
  }

  const scribe = new Scribe({
    workspacePath: config.workspace,
    autoCommit: false,
    autoPush: false,
  });
  const items = all ? scribe.rankAll() : scribe.rank(month);

  if (json) {
    printJson({ ok: true, month: all ? null : month ?? currentMonth(), items });
  } else {
    printFocus(items);
  }

  return 0;
}

function commandDoctor(
  args: ParsedArgs,
  config: ScribeConfig,
  configPath: string,
): number {
  const json = flagBool(args.flags, "json");
  const errors: string[] = [];
  const warnings: string[] = [];

  const workspaceExists = existsSync(config.workspace);
  if (!workspaceExists) {
    errors.push(`workspace does not exist: ${config.workspace}`);
  }

  let gitRepo = false;
  let remotes: string[] = [];
  if (workspaceExists) {
    gitRepo = isGitRepo(config.workspace);
    if (!gitRepo) {
      errors.push("workspace is not a git repository");
    } else {
      remotes = new Git(config.workspace, config.remote).remotes();
      if (remotes.length === 0) {
        if (!config.remote || !isRemoteTarget(config.remote)) {
          warnings.push(
            "no git remote configured; captures will commit locally only",
          );
        }
      } else if (
        config.remote &&
        !remotes.includes(config.remote) &&
        !isRemoteTarget(config.remote)
      ) {
        errors.push(`configured remote "${config.remote}" is not present`);
      }
    }
  }

  if (!existsSync(configPath)) {
    warnings.push(`config file not found at ${configPath}; using defaults`);
  }

  const result = {
    ok: errors.length === 0,
    configPath,
    workspace: config.workspace,
    workspaceExists,
    gitRepo,
    remotes,
    errors,
    warnings,
  };

  if (json) {
    printJson(result);
  } else {
    console.log(`workspace: ${tildifyPath(config.workspace)} (${workspaceExists ? "exists" : "missing"})`);
    console.log(`git: ${gitRepo ? `yes${remotes.length ? ` (${remotes.join(", ")})` : ""}` : "no"}`);
    console.log(`config: ${configPath}`);
    for (const error of errors) console.log(`error: ${error}`);
    for (const warning of warnings) console.log(`warning: ${warning}`);
    if (errors.length === 0) console.log("Scribe looks healthy.");
  }

  return errors.length === 0 ? 0 : 1;
}

function commandConfig(
  args: ParsedArgs,
  config: ScribeConfig,
  configPath: string,
): number {
  if (flagBool(args.flags, "json")) {
    printJson({ ok: true, configPath, config });
  } else {
    printConfig(config, configPath);
  }
  return 0;
}

async function commandHook(
  args: ParsedArgs,
  config: ScribeConfig,
): Promise<number> {
  const event = args.positionals[0] ?? "post-commit";
  const json = flagBool(args.flags, "json");
  const repoPath = flagString(args.flags, "repo");
  const agent = flagString(args.flags, "agent");
  const date = flagString(args.flags, "date");

  if (event === "post-commit" || event === "git-post-commit") {
    const outcome = await runPostCommitHook(config, {
      repoPath,
      agent,
      date,
    });
    if (json) {
      printJson(outcome);
    } else if (outcome.skipped) {
      console.log(`Hook skipped: ${outcome.reason ?? "nothing to capture"}`);
    } else {
      console.log(`Hook captured: ${outcome.entry?.title ?? ""}`);
      if (outcome.path) console.log(`  ${outcome.path}`);
    }
    return 0;
  }

  if (
    event === "agent-stop" ||
    event === "claude-stop" ||
    event === "opencode-stop"
  ) {
    let payload: AgentStopPayload = {};
    if (flagBool(args.flags, "stdin")) {
      const raw = await readStdin();
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as AgentStopPayload;
        }
      }
    }

    const title = flagString(args.flags, "title");
    const body = flagString(args.flags, "body");
    const category = flagString(args.flags, "category") as
      | AgentStopPayload["category"]
      | undefined;

    const outcome = await runAgentStopHook(config, {
      ...payload,
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(repoPath !== undefined ? { workspace: repoPath } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(date !== undefined ? { date } : {}),
    });

    if (json) {
      printJson(outcome);
    } else if (outcome.skipped) {
      console.log(`Hook skipped: ${outcome.reason ?? "nothing to capture"}`);
    } else {
      console.log(`Hook captured: ${outcome.entry?.title ?? ""}`);
      if (outcome.path) console.log(`  ${outcome.path}`);
    }
    return 0;
  }

  throw new Error(
    `unknown hook event "${event}" (expected post-commit or agent-stop)`,
  );
}

function commandHooks(args: ParsedArgs): number {
  const action = args.positionals[0] ?? "status";
  const json = flagBool(args.flags, "json");
  const repoPath = flagString(args.flags, "repo") ?? process.cwd();
  const useGit = flagBool(args.flags, "git") || !flagBool(args.flags, "skills");
  const useSkills = flagBool(args.flags, "skills");

  if (action === "install") {
    const gitResult = useGit ? installGitHook(repoPath) : undefined;
    const skillResult = useSkills ? installOpenCodeSkill() : undefined;
    const payload = {
      ok: true,
      ...(gitResult ? { gitHook: gitResult } : {}),
      ...(skillResult ? { openCodeSkill: skillResult } : {}),
    };
    if (json) {
      printJson(payload);
    } else {
      if (gitResult) {
        console.log(`Installed git post-commit hook: ${gitResult.hookPath}`);
      }
      if (skillResult) {
        console.log(`Installed OpenCode skill: ${skillResult.skillPath}`);
      }
    }
    return 0;
  }

  if (action === "uninstall") {
    const gitResult = uninstallGitHook(repoPath);
    if (json) {
      printJson({ ok: true, gitHook: gitResult });
    } else {
      console.log(
        gitResult.removed
          ? `Removed git post-commit hook: ${gitResult.hookPath}`
          : `No Scribe git hook found at ${gitResult.hookPath}`,
      );
    }
    return 0;
  }

  if (action === "status") {
    const gitResult = gitHookStatus(repoPath);
    if (json) {
      printJson({ ok: true, gitHook: gitResult });
    } else {
      console.log(
        `git post-commit hook: ${gitResult.installed ? "installed" : "not installed"} (${gitResult.hookPath})`,
      );
    }
    return 0;
  }

  throw new Error(
    `unknown hooks action "${action}" (expected install, uninstall, or status)`,
  );
}

function packageVersion(): string {
  try {
    const packagePath = join(__dirname, "..", "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
      version?: string;
    };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(): void {
  console.log(`Scribe — markdown knowledge base companion

Usage:
  scribe <command> [options]

Commands:
  init       Initialize the journal, config, and optional git repo
  capture    Capture a knowledge entry or reminder
  read       Read knowledge entries
  reminders  Read reminders
  focus      Rank knowledge entries for a focus list
  mcp        Start the Model Context Protocol (MCP) server on stdio
  hook       Run an automatic capture hook (post-commit, agent-stop)
  hooks      Install, uninstall, or check git hooks and agent skills
  doctor     Check config, workspace, git, and remote
  config     Show resolved configuration
  help       Show this help

Global options:
  --workspace <path>   Journal/workspace path
  --config <path>      Config file path
  --remote <name>      Git remote name or URL
  --agent <name>       Default agent label
  --json               Emit JSON
  --no-commit          Do not commit after capture
  --no-push            Do not push after capture
  --version            Show version

Capture options:
  --type <knowledge|reminder>
  --title <title>
  --date <YYYY-MM-DD>
  --repo <path>        Workspace/repo the entry applies to
  --category <finding|decision|work-log>
  --body <markdown>
  --priority <p1|p2|p3>
  --context <text>
  --action <markdown>
  --stdin              Read a JSON entry from stdin
  --dry-run            Validate without writing

Read options:
  --month <YYYY-MM>
  --all`);
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv);

  if (flagBool(args.flags, "version") || args.command === "version") {
    console.log(`scribe ${packageVersion()}`);
    return 0;
  }

  if (
    flagBool(args.flags, "help") ||
    args.command === undefined ||
    args.command === "help"
  ) {
    printHelp();
    return 0;
  }

  const configPath = configPathFrom(args);
  const config = loadConfig({ ...configOverrides(args), configPath });

  switch (args.command) {
    case "init":
      return commandInit(args, config, configPath);
    case "capture":
      return commandCapture(args, config);
    case "read":
      return commandRead(args, config);
    case "reminders":
      return commandReminders(args, config);
    case "focus":
      return commandFocus(args, config);
    case "mcp":
      return runMcpServer({ ...configOverrides(args), configPath });
    case "hook":
      return commandHook(args, config);
    case "hooks":
      return commandHooks(args);
    case "doctor":
      return commandDoctor(args, config, configPath);
    case "config":
      return commandConfig(args, config, configPath);
    default:
      throw new Error(`unknown command "${args.command}"`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (process.argv.includes("--json")) {
        printJson({ ok: false, error: message });
      } else {
        console.error(`scribe: ${message}`);
      }
      process.exitCode = 1;
    });
}
