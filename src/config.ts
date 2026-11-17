import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, resolve } from "path";

export interface ScribeConfig {
  /** Absolute path to the Scribe journal/workspace. */
  workspace: string;
  /** Git remote name or URL. When omitted, git's configured remotes are used. */
  remote?: string;
  /** Default agent label for captured entries. */
  agent: string;
  /** Commit automatically after capture. */
  autoCommit: boolean;
  /** Push automatically after a commit when a remote exists. */
  autoPush: boolean;
  /** Exact literal values to redact from captured text. */
  redactionLiterals?: string[];
}

export interface ConfigOverrides {
  configPath?: string;
  workspace?: string;
  remote?: string;
  agent?: string;
  autoCommit?: boolean;
  autoPush?: boolean;
  redactionLiterals?: string[];
}

export const DEFAULT_WORKSPACE = `${homedir()}/notes/scribe-journal`;
export const DEFAULT_AGENT = "scribe";

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || `${homedir()}/.config`;
  return `${resolve(base)}/scribe/config.json`;
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}/${value.slice(2)}`;
  return value;
}

export function tildifyPath(value: string): string {
  const home = homedir();
  if (value === home) return "~";
  if (value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
}

export function resolvePath(value: string, cwd: string = process.cwd()): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function envBoolean(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function validateRedactionLiterals(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("redactionLiterals must be an array of at most 100 strings");
  }

  const literals: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 256 ||
      /[\r\n]/.test(item)
    ) {
      throw new Error(
        "each redaction literal must be 1-256 characters and contain no line breaks",
      );
    }
    if (!literals.includes(item)) literals.push(item);
  }
  return literals;
}

function envRedactionLiterals(): string[] | undefined {
  const value = process.env.SCRIBE_REDACTION_LITERALS;
  if (value === undefined) return undefined;
  try {
    return validateRedactionLiterals(JSON.parse(value));
  } catch (error) {
    throw new Error(
      `invalid SCRIBE_REDACTION_LITERALS: ${(error as Error).message}`,
    );
  }
}

export function loadConfig(overrides: ConfigOverrides = {}): ScribeConfig {
  const configPath =
    overrides.configPath ?? process.env.SCRIBE_CONFIG ?? defaultConfigPath();

  let fileConfig: Partial<ScribeConfig> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") {
        fileConfig = parsed as Partial<ScribeConfig>;
      }
    } catch (error) {
      throw new Error(
        `Could not parse Scribe config at ${configPath}: ${(error as Error).message}`,
      );
    }
  }

  const workspaceValue =
    overrides.workspace ??
    process.env.SCRIBE_WORKSPACE ??
    fileConfig.workspace ??
    DEFAULT_WORKSPACE;
  const redactionLiterals = validateRedactionLiterals(
    overrides.redactionLiterals ??
      envRedactionLiterals() ??
      fileConfig.redactionLiterals,
  );

  return {
    workspace: resolvePath(workspaceValue),
    remote: overrides.remote ?? process.env.SCRIBE_REMOTE ?? fileConfig.remote,
    agent:
      overrides.agent ??
      process.env.SCRIBE_AGENT ??
      fileConfig.agent ??
      DEFAULT_AGENT,
    autoCommit:
      overrides.autoCommit ??
      envBoolean("SCRIBE_AUTO_COMMIT") ??
      fileConfig.autoCommit ??
      true,
    autoPush:
      overrides.autoPush ??
      envBoolean("SCRIBE_AUTO_PUSH") ??
      fileConfig.autoPush ??
      true,
    ...(redactionLiterals.length > 0 ? { redactionLiterals } : {}),
  };
}

export function saveConfig(
  config: ScribeConfig,
  configPath: string = defaultConfigPath(),
): string {
  const fileConfig = {
    workspace: tildifyPath(config.workspace),
    ...(config.remote ? { remote: config.remote } : {}),
    agent: config.agent,
    autoCommit: config.autoCommit,
    autoPush: config.autoPush,
    ...(config.redactionLiterals?.length
      ? { redactionLiterals: config.redactionLiterals }
      : {}),
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(fileConfig, null, 2)}\n`);
  return configPath;
}
