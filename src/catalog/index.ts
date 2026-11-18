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
  version: 2;
  redactionHash: string;
  files: Record<string, { size: number; mtimeMs: number; hash: string }>;
  records: IndexedCatalogRecord[];
  postings: Record<string, Array<{ id: string; tf: number; length: number }>>;
  averageLength: number;
}

interface IndexedCatalogRecord extends CatalogRecord {
  termFrequencies: Record<string, number>;
  documentLength: number;
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
      parsed.version === 2 &&
      parsed.files &&
      Array.isArray(parsed.records) &&
      parsed.postings &&
      typeof parsed.averageLength === "number"
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
): IndexedCatalogRecord[] {
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

    const termFrequencies: Record<string, number> = {};
    const addTerms = (value: string, weight: number): number => {
      const values =
        value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{1,}/gu) ?? [];
      for (const token of values) {
        if (token.length < 3 || STOP_WORDS.has(token)) continue;
        termFrequencies[token] = (termFrequencies[token] ?? 0) + weight;
      }
      return values.filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
        .length;
    };
    const bodyLength = addTerms(entry.body, 1);
    const titleLength = addTerms(entry.title, 3);
    const tagLength = tags.reduce((count, tag) => count + addTerms(tag, 2), 0);
    const summaryLength = addTerms(summary, 1);

    return {
      id,
      path,
      date: entry.date,
      title: entry.title,
      workspace: entry.workspace ? tildifyPath(entry.workspace) : "",
      category: entry.category,
      summary,
      tags,
      termFrequencies,
      documentLength: Math.max(
        bodyLength + titleLength + tagLength + summaryLength,
        1,
      ),
    };
  });
}

function buildPostings(records: IndexedCatalogRecord[]): {
  postings: CatalogCache["postings"];
  averageLength: number;
} {
  const postings: CatalogCache["postings"] = {};
  let totalLength = 0;

  for (const record of records) {
    totalLength += record.documentLength;
    for (const [term, tf] of Object.entries(record.termFrequencies)) {
      (postings[term] ??= []).push({
        id: record.id,
        tf,
        length: record.documentLength,
      });
    }
  }

  return {
    postings,
    averageLength: records.length > 0 ? totalLength / records.length : 0,
  };
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
  const recordsByMonth = new Map<string, IndexedCatalogRecord[]>();

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
  const index =
    updatedMonths.length === 0 && previous?.redactionHash === redactionHash
      ? {
          postings: previous.postings,
          averageLength: previous.averageLength,
        }
      : buildPostings(records);
  const cache: CatalogCache = {
    version: 2,
    redactionHash,
    files: currentFiles,
    records,
    ...index,
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
    records: records.map(publicRecord),
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

function queryTokens(query: string): string[] {
  const tokens =
    query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{1,}/gu) ?? [];
  return [...new Set(tokens.filter((token) => !STOP_WORDS.has(token)))];
}

function rankIndexedCatalog(
  records: IndexedCatalogRecord[],
  postings: CatalogCache["postings"],
  averageLength: number,
  query: string,
  limit: number,
): CatalogRecord[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0 || records.length === 0) return [];

  const scores = new Map<string, number>();
  const totalDocuments = records.length;
  const k1 = 1.2;
  const b = 0.75;

  for (const token of tokens) {
    const matches = postings[token];
    if (!matches?.length) continue;
    const documentFrequency = matches.length;
    const inverseFrequency = Math.log(
      1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    for (const match of matches) {
      const lengthNorm =
        k1 *
        (1 - b + b * match.length / Math.max(averageLength, 1));
      const score =
        inverseFrequency *
        ((match.tf * (k1 + 1)) / (match.tf + lengthNorm));
      scores.set(match.id, (scores.get(match.id) ?? 0) + score);
    }
  }

  const byId = new Map(records.map((record) => [record.id, record]));
  return [...scores.entries()]
    .map(([id, score]) => ({ record: byId.get(id), score }))
    .filter(
      (item): item is { record: IndexedCatalogRecord; score: number } =>
        Boolean(item.record),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.record.date.localeCompare(a.record.date) ||
        a.record.title.localeCompare(b.record.title),
    )
    .slice(0, Math.max(1, limit))
    .map((item) => publicRecord(item.record));
}

function publicRecord(record: IndexedCatalogRecord): CatalogRecord {
  const { termFrequencies: _termFrequencies, documentLength: _documentLength, ...result } =
    record;
  return result;
}

function indexPublicRecord(record: CatalogRecord): IndexedCatalogRecord {
  const termFrequencies: Record<string, number> = {};
  const add = (value: string, weight: number): number => {
    const values =
      value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{1,}/gu) ?? [];
    for (const token of values) {
      if (token.length < 3 || STOP_WORDS.has(token)) continue;
      termFrequencies[token] = (termFrequencies[token] ?? 0) + weight;
    }
    return values.filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
      .length;
  };
  const length =
    add(record.title, 3) +
    add(record.summary, 1) +
    record.tags.reduce((total, tag) => total + add(tag, 2), 0);
  return {
    ...record,
    termFrequencies,
    documentLength: Math.max(length, 1),
  };
}

export function searchCatalog(
  records: CatalogRecord[],
  query: string,
  limit = 10,
): CatalogRecord[] {
  const indexedRecords = records.map(indexPublicRecord);
  const { postings, averageLength } = buildPostings(indexedRecords);
  return rankIndexedCatalog(
    indexedRecords,
    postings,
    averageLength,
    query,
    limit,
  );
}

export function searchLocalCatalog(
  storage: KnowledgeBase,
  workspacePath: string,
  redactionLiterals: readonly string[],
  query: string,
  limit = 10,
): CatalogRecord[] {
  const build = buildLocalCatalog(storage, workspacePath, redactionLiterals);
  const cache = loadCache(build.path);
  if (!cache) return searchCatalog(build.records, query, limit);
  return rankIndexedCatalog(
    cache.records,
    cache.postings,
    cache.averageLength,
    query,
    limit,
  );
}
