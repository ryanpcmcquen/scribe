import { execSync } from "child_process";

export interface GitLike {
  commit(message: string): Promise<void>;
  push(): Promise<void>;
}

export class Git {
  constructor(private readonly repoPath: string, private readonly remote?: string) {}

  private run(args: string): void {
    execSync(`git ${args}`, { cwd: this.repoPath, stdio: "pipe" });
  }

  async commit(message: string): Promise<void> {
    const status = execSync("git status --porcelain", { cwd: this.repoPath, stdio: "pipe" })
      .toString()
      .trim();
    if (!status) return; // nothing to commit
    this.run("add -A");
    this.run(`commit -m "${message}"`);
  }

  async push(): Promise<void> {
    if (!this.remote) return; // no push when offline or unconfigured
    this.run("push");
  }
}
