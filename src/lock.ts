import { createHash, randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

interface LockOwner {
  pid: number;
  token: string;
}

const LOCK_TIMEOUT_MS = 60_000;
const STALE_LOCK_AGE_MS = 30_000;

function lockDirectory(workspacePath: string): string {
  const resolvedWorkspace = resolve(workspacePath);
  const identityPath = existsSync(resolvedWorkspace)
    ? realpathSync(resolvedWorkspace)
    : resolvedWorkspace;
  const identity = createHash("sha256")
    .update(identityPath)
    .digest("hex");
  return join(tmpdir(), "scribe-locks", `${identity}.lock`);
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockPath, "owner.json"), "utf8"),
    ) as Partial<LockOwner>;
    if (
      typeof owner.pid !== "number" ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.token !== "string"
    ) {
      return undefined;
    }
    return owner as LockOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function reclaimIfStale(lockPath: string): void {
  if (!existsSync(lockPath)) return;

  let lockAge: number;
  try {
    lockAge = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return;
  }
  const owner = readLockOwner(lockPath);
  if (owner) {
    if (isProcessAlive(owner.pid)) return;
  } else if (lockAge < STALE_LOCK_AGE_MS) {
    return;
  }

  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    const currentOwner = readLockOwner(lockPath);
    if (currentOwner && isProcessAlive(currentOwner.pid)) return;
    renameLock(lockPath, stalePath);
    rmSync(stalePath, { recursive: true, force: true });
  } catch {
    return;
  }
}

function renameLock(source: string, destination: string): void {
  renameSync(source, destination);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * Run a workspace operation under a cross-process lock. This serializes
 * duplicate checks, markdown writes, commits, and pushes for one journal.
 */
export async function withWorkspaceLock<T>(
  workspacePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = lockDirectory(workspacePath);
  mkdirSync(dirname(lockPath), { recursive: true });

  const token = randomUUID();
  const startedAt = Date.now();

  while (true) {
    let created = false;
    try {
      mkdirSync(lockPath);
      created = true;
      writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, token } satisfies LockOwner),
      );
      break;
    } catch (error) {
      if (created) {
        rmSync(lockPath, { recursive: true, force: true });
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      reclaimIfStale(lockPath);
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(
          `timed out waiting for another Scribe operation on ${workspacePath}`,
        );
      }
      await delay(25 + Math.floor(Math.random() * 50));
    }
  }

  try {
    return await operation();
  } finally {
    const owner = readLockOwner(lockPath);
    if (owner?.token === token) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
}
