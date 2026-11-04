import { Git } from "./git";
import { KnowledgeBase, KnowledgeEntry, ReminderEntry } from "./storage";

export interface ScribeOptions {
  workspacePath: string;
  repoPath?: string;
  remote?: string;
}

type ScribeEntry = KnowledgeEntry | ReminderEntry;

export class Scribe {
  readonly storage: KnowledgeBase;
  readonly git: Git;

  constructor(options: ScribeOptions) {
    this.storage = new KnowledgeBase(options.workspacePath);
    this.git = new Git(options.repoPath ?? options.workspacePath, options.remote);
  }

  /**
   * Capture an entry: write to the knowledge/reminders store, commit, push.
   */
  async record(entry: ScribeEntry): Promise<string> {
    let path: string;
    if ("category" in entry) {
      path = this.storage.appendKnowledgeEntry(entry);
    } else {
      path = this.storage.appendReminder(entry);
    }

    await this.git.commit(`Scribe: ${entry.date} — ${entry.title}`);
    await this.git.push();

    return path;
  }

  /**
   * Read accumulated knowledge entries (e.g., for Flint's focus merge).
   */
  readKnowledge(month?: string): KnowledgeEntry[] {
    return this.storage.readKnowledge(month);
  }
}
