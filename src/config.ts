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
}

export interface ConfigOverrides {
  configPath?: string;
  workspace?: string;
  remote?: string;
  agent?: string;
  autoCommit?: boolean;
  autoPush?: boolean;
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
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(fileConfig, null, 2)}\n`);
  return configPath;
}
