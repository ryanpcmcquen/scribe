import { Git } from "./git";
import { KnowledgeBase, KnowledgeEntry, ReminderEntry } from "./storage";
import { composeFocus, FocusItem, FocusSourceContribution, rankScribeEntries } from "./merge";

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

  /**
   * Rank accumulated Scribe knowledge entries for Flint's focus merge.
   */
  rank(month?: string): FocusItem[] {
    return rankScribeEntries(this.storage.readKnowledge(month));
  }

  /**
   * Compose Scribe's ranked knowledge into Flint's focus list, merging
   * additional sources when provided.
   */
  compose(month: string | undefined, additionalSources: FocusSourceContribution[] = []): FocusItem[] {
    const items = this.rank(month);
    return composeFocus(items, additionalSources);
  }
}
