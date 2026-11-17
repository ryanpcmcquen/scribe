import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, relative, sep } from "path";
import { tildifyPath } from "../config";
import { KnowledgeBase, KnowledgeEntry } from "../storage";

export interface CatalogRecord {
  id: string;
  path: string;
  date: string;
  title: string;
  workspace: string;
  category: KnowledgeEntry["category"];
  summary: string;
  tags: string[];
}

export interface CatalogBuildResult {
  path: string;
  total: number;
  updatedMonths: string[];
  reusedMonths: string[];
  records: CatalogRecord[];
}

interface CatalogCache {
  version: 1;
  redactionHash: string;
  files: Record<string, { size: number; mtimeMs: number; hash: string }>;
  records: CatalogRecord[];
}

const STOP_WORDS = new Set(
  `a about after all also an and any are as at be because been before between both but by can could did do does each few for from further get had has have having he her here hers him his how i if in into is it its just may me more most my no nor not of on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up use very was we were what when where which while who will with would you your`.split(
    " ",
  ),
);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(value: string): string {
  return value.split(sep).join("/");
}

export function extractiveSummary(text: string, maxChars = 280): string {
  const withoutFences = text.replace(/```[\s\S]*?```/g, " ");
  const paragraphs = withoutFences
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .filter((line) => !/^\s*(#{1,6}\s|[-*+]\s|>\s)/.test(line))
        .join(" ")
        .replace(/[`*_~]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);

  const summary = paragraphs[0] ?? "";
  if (summary.length <= maxChars) return summary;
  const boundary = summary.lastIndexOf(" ", maxChars - 1);
  const end = boundary > maxChars * 0.6 ? boundary : maxChars - 1;
  return `${summary.slice(0, end).trimEnd()}…`;
}

export function deriveAutomaticTags(
  title: string,
  body: string,
  limit = 8,
): string[] {
  const titleTokens =
    title.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{1,}/gu) ?? [];
  const bodyTokens =
    body.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{1,}/gu) ?? [];
  const scores = new Map<string, number>();

  for (const token of bodyTokens) {
    if (token.length < 3 || STOP_WORDS.has(token)) continue;
    scores.set(token, (scores.get(token) ?? 0) + 1);
  }
  for (const token of titleTokens) {
    if (token.length < 3 || STOP_WORDS.has(token)) continue;
    scores.set(token, (scores.get(token) ?? 0) + 4);
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag);
}

function catalogPath(workspacePath: string): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(
    cacheHome,
    "scribe",
    "catalog",
    `${digest(workspacePath)}.json`,
  );
}

function loadCache(path: string): CatalogCache | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CatalogCache;
    if (
      parsed.version === 1 &&
      parsed.files &&
      Array.isArray(parsed.records)
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function recordsForMonth(
  storage: KnowledgeBase,
  workspacePath: string,
  month: string,
): CatalogRecord[] {
  const filePath = storage.knowledgeFileFor(`${month}-01`);
  const path = normalizeRelativePath(relative(workspacePath, filePath));
  return storage.readKnowledge(month).map((rawEntry) => {
    const entry = storage.sanitizeKnowledgeEntry(rawEntry);
    const tags = [
      ...new Set([
        ...(entry.tags ?? []),
        ...deriveAutomaticTags(entry.title, entry.body),
      ]),
    ].slice(0, 8);
    const summary = entry.summary || extractiveSummary(entry.body);
    const id = digest(
      [path, entry.date, entry.title, entry.sourceId ?? "", entry.body].join(
        "\0",
      ),
    ).slice(0, 20);

    return {
      id,
      path,
      date: entry.date,
      title: entry.title,
      workspace: entry.workspace ? tildifyPath(entry.workspace) : "",
      category: entry.category,
      summary,
      tags,
    };
  });
}

export function buildLocalCatalog(
  storage: KnowledgeBase,
  workspacePath: string,
  redactionLiterals: readonly string[] = [],
  options: { force?: boolean } = {},
): CatalogBuildResult {
  const path = catalogPath(workspacePath);
  const previous = loadCache(path);
  const redactionHash = digest([...redactionLiterals].sort().join("\0"));
  const months = storage.listMonths("knowledge");
  const currentFiles: CatalogCache["files"] = {};
  const updatedMonths: string[] = [];
  const reusedMonths: string[] = [];
  const recordsByMonth = new Map<string, CatalogRecord[]>();

  for (const month of months) {
    const filePath = storage.knowledgeFileFor(`${month}-01`);
    const relativePath = normalizeRelativePath(relative(workspacePath, filePath));
    let fileStat;
    try {
      fileStat = statSync(filePath);
    } catch {
      updatedMonths.push(month);
      recordsByMonth.set(month, []);
      continue;
    }

    if (
      !options.force &&
      previous?.redactionHash === redactionHash &&
      previous.files[month]?.size === fileStat.size &&
      previous.files[month]?.mtimeMs === fileStat.mtimeMs
    ) {
      currentFiles[month] = previous.files[month];
      const existing = previous.records.filter(
        (record) => record.path === relativePath,
      );
      recordsByMonth.set(month, existing);
      reusedMonths.push(month);
    } else {
      const content = readFileSync(filePath, "utf8");
      currentFiles[month] = {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        hash: digest(content),
      };
      recordsByMonth.set(
        month,
        recordsForMonth(storage, workspacePath, month),
      );
      updatedMonths.push(month);
    }
  }

  const records = months.flatMap((month) => recordsByMonth.get(month) ?? []);
  const cache: CatalogCache = {
    version: 1,
    redactionHash,
    files: currentFiles,
    records,
  };

  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(cache)}\n`);
  renameSync(temporaryPath, path);

  return {
    path,
    total: records.length,
    updatedMonths,
    reusedMonths,
    records,
  };
}

export function updateLocalCatalogIfPresent(
  storage: KnowledgeBase,
  workspacePath: string,
  redactionLiterals: readonly string[] = [],
): CatalogBuildResult | undefined {
  if (!existsSync(catalogPath(workspacePath))) return undefined;
  return buildLocalCatalog(storage, workspacePath, redactionLiterals);
}

export function searchCatalog(
  records: CatalogRecord[],
  query: string,
  limit = 10,
): CatalogRecord[] {
  const tokens =
    query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{1,}/gu) ?? [];
  if (tokens.length === 0) return [];

  const scored = records
    .map((record) => {
      const title = record.title.toLowerCase();
      const tags = record.tags.join(" ").toLowerCase();
      const summary = record.summary.toLowerCase();
      const workspace = record.workspace.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (title.includes(token)) score += 8;
        if (tags.includes(token)) score += 5;
        if (summary.includes(token)) score += 2;
        if (workspace.includes(token)) score += 1;
      }
      if (tokens.length > 1 && tokens.every((token) =>
        `${title} ${tags} ${summary} ${workspace}`.includes(token),
      )) {
        score += 3;
      }
      return { record, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.record.date.localeCompare(a.record.date) ||
        a.record.title.localeCompare(b.record.title),
    );

  return scored.slice(0, Math.max(1, limit)).map((item) => item.record);
}
