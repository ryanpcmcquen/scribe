import { KnowledgeEntry } from "../storage";

export interface FocusItem {
  entry: KnowledgeEntry;
  score: number;
  source: "scribe";
}

export interface FocusSourceContribution {
  source: string;
  items: FocusItem[];
}

const CATEGORY_WEIGHTS: Record<string, number> = {
  decision: 3,
  finding: 2,
  "work-log": 1,
};

export function rankScribeEntries(entries: KnowledgeEntry[]): FocusItem[] {
  const items: FocusItem[] = entries.map((entry) => ({
    entry,
    score: CATEGORY_WEIGHTS[entry.category] ?? 0,
    source: "scribe" as const,
  }));
  return items.sort((a, b) => b.score - a.score);
}

export function composeFocus(scribeItems: FocusItem[], additionalSources: FocusSourceContribution[] = []): FocusItem[] {
  const merged: FocusItem[] = [...scribeItems];
  for (const source of additionalSources) {
    merged.push(...source.items);
  }
  return merged.sort((a, b) => b.score - a.score);
}
