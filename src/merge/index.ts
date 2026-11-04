import { KnowledgeEntry } from "../storage";

export interface FocusItem {
  entry: KnowledgeEntry;
  score: number;
  source: "scribe";
}

const CATEGORY_WEIGHTS: Record<string, number> = {
  decision: 3,
  finding: 2,
  "work-log": 1,
};

/**
 * Rank Scribe knowledge entries for Flint's focus synthesis.
 * Higher scores surface higher-priority accumulated knowledge.
 */
export function rankScribeEntries(entries: KnowledgeEntry[]): FocusItem[] {
  const items: FocusItem[] = entries.map((entry) => ({
    entry,
    score: CATEGORY_WEIGHTS[entry.category] ?? 0,
    source: "scribe" as const,
  }));
  return items.sort((a, b) => b.score - a.score);
}
