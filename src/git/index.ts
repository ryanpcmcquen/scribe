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
  rebased?: boolean;
  error?: string;
}

export interface PullResult {
  pulled: boolean;
  rebased?: boolean;
  error?: string;
}

export interface SyncResult {
  committed: boolean;
  pulled: boolean;
  rebased: boolean;
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
    const candidate = error as {
      stderr?: Buffer;
      stdout?: Buffer;
      message?: string;
    };
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

  private resolveRemote(): { remote?: string; error?: string } {
    const remotes = this.remotes();
    const remote =
      this.remote ?? (remotes.includes("origin") ? "origin" : remotes[0]);
    if (!remote) {
      return {};
    }
    if (!remotes.includes(remote) && !isRemoteTarget(remote)) {
      return { error: `remote "${remote}" is not configured` };
    }
    return { remote };
  }

  private remoteHasBranch(remote: string, branch: string): boolean {
    const heads = this.run(
      ["ls-remote", "--heads", remote, `refs/heads/${branch}`],
      true,
    );
    return Boolean(heads);
  }

  async commit(message: string): Promise<boolean> {
    if (!this.isRepo()) return false;

    const status = this.run(["status", "--porcelain"], true);
    if (!status) return false;

    this.run(["add", "-A"]);
    this.run(["commit", "-m", message]);
    return true;
  }

  async pull(): Promise<PullResult> {
    if (!this.isRepo()) {
      return { pulled: false, error: "not a git repository" };
    }

    const { remote, error } = this.resolveRemote();
    if (error) {
      return { pulled: false, error };
    }
    if (!remote) {
      return { pulled: false };
    }

    const branch = this.currentBranch();
    if (!this.remoteHasBranch(remote, branch)) {
      return { pulled: false };
    }

    const beforeHead = this.run(["rev-parse", "HEAD"], true);
    try {
      this.run(["pull", "--rebase", "--autostash", remote, branch]);
      const afterHead = this.run(["rev-parse", "HEAD"], true);
      return {
        pulled: true,
        ...(beforeHead && afterHead && beforeHead !== afterHead
          ? { rebased: true }
          : {}),
      };
    } catch (pullError) {
      this.run(["rebase", "--abort"], true);
      return { pulled: false, error: this.errorMessage(pullError) };
    }
  }

  async push(): Promise<PushResult> {
    if (!this.isRepo()) {
      return { pushed: false, error: "not a git repository" };
    }

    const { remote, error } = this.resolveRemote();
    if (error) {
      return { pushed: false, error };
    }
    if (!remote) {
      return { pushed: false };
    }

    const branch = this.currentBranch();
    try {
      this.run(["push", remote, branch]);
      return { pushed: true };
    } catch (firstError) {
      try {
        this.run(["pull", "--rebase", "--autostash", remote, branch]);
      } catch {
        this.run(["rebase", "--abort"], true);
        return { pushed: false, error: this.errorMessage(firstError) };
      }

      try {
        this.run(["push", remote, branch]);
        return { pushed: true, rebased: true };
      } catch (retryError) {
        return { pushed: false, error: this.errorMessage(retryError) };
      }
    }
  }

  async sync(
    options: {
      commitMessage?: string;
      autoCommit?: boolean;
      autoPush?: boolean;
    } = {},
  ): Promise<SyncResult> {
    if (!this.isRepo()) {
      return {
        committed: false,
        pulled: false,
        rebased: false,
        pushed: false,
        error: "not a git repository",
      };
    }

    const autoCommit = options.autoCommit ?? true;
    const autoPush = options.autoPush ?? true;
    const commitMessage = options.commitMessage ?? "Scribe: sync journal";

    const committed = autoCommit ? await this.commit(commitMessage) : false;
    const pullResult = await this.pull();
    if (pullResult.error) {
      return {
        committed,
        pulled: false,
        rebased: false,
        pushed: false,
        error: pullResult.error,
      };
    }

    let pushed = false;
    let rebased = Boolean(pullResult.rebased);
    let pushError: string | undefined;
    if (autoPush) {
      const pushResult = await this.push();
      pushed = pushResult.pushed;
      rebased = rebased || Boolean(pushResult.rebased);
      pushError = pushResult.error;
    }

    return {
      committed,
      pulled: pullResult.pulled,
      rebased,
      pushed,
      ...(pushError ? { error: pushError } : {}),
    };
  }
}
