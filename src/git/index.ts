import { execFileSync } from "child_process";
import { realpathSync } from "fs";

/**
 * True when a configured remote is a URL or path that git can push to
 * directly, rather than the name of a configured remote.
 */
export function isRemoteTarget(value: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    value.includes("@") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    /^[a-z]:[\\/]/i.test(value)
  );
}

export interface PushResult {
  pushed: boolean;
  error?: string;
}

export interface GitLike {
  commit(message: string): Promise<boolean>;
  push(): Promise<PushResult>;
}

export class Git {
  constructor(
    private readonly repoPath: string,
    private readonly remote?: string,
  ) {}

  private errorMessage(error: unknown): string {
    const candidate = error as { stderr?: Buffer; stdout?: Buffer; message?: string };
    const stderr = candidate.stderr?.toString().trim();
    const stdout = candidate.stdout?.toString().trim();
    return stderr || stdout || candidate.message || String(error);
  }

  private run(args: string[], allowFailure = false): string {
    try {
      return execFileSync("git", args, {
        cwd: this.repoPath,
        stdio: "pipe",
      })
        .toString()
        .trim();
    } catch (error) {
      if (allowFailure) return "";
      throw new Error(this.errorMessage(error));
    }
  }

  isRepo(): boolean {
    try {
      const top = this.run(["rev-parse", "--show-toplevel"], true);
      return top !== "" && realpathSync(top) === realpathSync(this.repoPath);
    } catch {
      return false;
    }
  }

  remotes(): string[] {
    const output = this.run(["remote"], true);
    return output ? output.split("\n").filter(Boolean) : [];
  }

  currentBranch(): string {
    return this.run(["rev-parse", "--abbrev-ref", "HEAD"], true) || "main";
  }

  async commit(message: string): Promise<boolean> {
    if (!this.isRepo()) return false;

    const status = this.run(["status", "--porcelain"], true);
    if (!status) return false;

    this.run(["add", "-A"]);
    this.run(["commit", "-m", message]);
    return true;
  }

  async push(): Promise<PushResult> {
    if (!this.isRepo()) {
      return { pushed: false, error: "not a git repository" };
    }

    const remotes = this.remotes();
    const remote =
      this.remote ?? (remotes.includes("origin") ? "origin" : remotes[0]);
    if (!remote) {
      return { pushed: false };
    }

    if (!remotes.includes(remote) && !isRemoteTarget(remote)) {
      return { pushed: false, error: `remote "${remote}" is not configured` };
    }

    try {
      this.run(["push", remote, this.currentBranch()]);
      return { pushed: true };
    } catch (error) {
      return { pushed: false, error: this.errorMessage(error) };
    }
  }
}
