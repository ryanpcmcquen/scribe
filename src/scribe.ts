import { DEFAULT_WORKSPACE } from "./config";
import { Git } from "./git";
import {
  KnowledgeBase,
  KnowledgeEntry,
  ReminderEntry,
  ScribeEntry,
} from "./storage";
import {
  composeFocus,
  FocusItem,
  FocusSourceContribution,
  rankScribeEntries,
} from "./merge";

export interface ScribeOptions {
  workspacePath?: string;
  repoPath?: string;
  remote?: string;
  autoCommit?: boolean;
  autoPush?: boolean;
}

export interface CaptureResult {
  path: string;
  committed: boolean;
  pushed: boolean;
  pushError?: string;
}

export class Scribe {
  readonly storage: KnowledgeBase;
  readonly git: Git;

  private readonly autoCommit: boolean;
  private readonly autoPush: boolean;

  constructor(options: ScribeOptions) {
    const workspacePath = options.workspacePath ?? DEFAULT_WORKSPACE;
    this.storage = new KnowledgeBase(workspacePath);
    this.git = new Git(options.repoPath ?? workspacePath, options.remote);
    this.autoCommit = options.autoCommit ?? true;
    this.autoPush = options.autoPush ?? true;
  }

  /**
   * Capture an entry: write to the knowledge/reminders store, commit, push.
   */
  async record(entry: ScribeEntry): Promise<CaptureResult> {
    const path =
      "category" in entry
        ? this.storage.appendKnowledgeEntry(entry)
        : this.storage.appendReminder(entry);

    const committed = this.autoCommit
      ? await this.git.commit(`Scribe: ${entry.date} — ${entry.title}`)
      : false;

    let pushed = false;
    let pushError: string | undefined;
    if (this.autoPush && committed) {
      const result = await this.git.push();
      pushed = result.pushed;
      pushError = result.error;
    }

    return {
      path,
      committed,
      pushed,
      ...(pushError ? { pushError } : {}),
    };
  }

  /**
   * The markdown file an entry would be written to (useful for --dry-run).
   */
  pathFor(entry: ScribeEntry): string {
    return "category" in entry
      ? this.storage.knowledgeFileFor(entry.date)
      : this.storage.reminderFileFor(entry.date);
  }

  /**
   * Read accumulated knowledge entries (e.g., for Flint's focus merge).
   */
  readKnowledge(month?: string): KnowledgeEntry[] {
    return this.storage.readKnowledge(month);
  }

  readAllKnowledge(): KnowledgeEntry[] {
    return this.storage.readAllKnowledge();
  }

  readReminders(month?: string): ReminderEntry[] {
    return this.storage.readReminders(month);
  }

  readAllReminders(): ReminderEntry[] {
    return this.storage.readAllReminders();
  }

  /**
   * Rank accumulated Scribe knowledge entries for Flint's focus merge.
   */
  rank(month?: string): FocusItem[] {
    return rankScribeEntries(this.storage.readKnowledge(month));
  }

  rankAll(): FocusItem[] {
    return rankScribeEntries(this.storage.readAllKnowledge());
  }

  /**
   * Compose Scribe's ranked knowledge into Flint's focus list, merging
   * additional sources when provided.
   */
  compose(
    month: string | undefined,
    additionalSources: FocusSourceContribution[] = [],
  ): FocusItem[] {
    return composeFocus(this.rank(month), additionalSources);
  }
}
