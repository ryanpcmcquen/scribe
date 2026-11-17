import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { lookup } from "dns/promises";
import {
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "path";
import { isIP } from "net";
import { isDate, localDate } from "../date";
import { deriveAutomaticTags } from "../catalog";
import { resolvePath, tildifyPath } from "../config";
import { KnowledgeEntry } from "../storage";

export type ImportFormat =
  | "auto"
  | "markdown"
  | "json"
  | "jsonl"
  | "text"
  | "html"
  | "git"
  | "url";

export interface ImportOptions {
  source: string;
  format?: ImportFormat;
  workspace?: string;
  agent?: string;
  date?: string;
  limit?: number;
  since?: string;
  allowPrivateNetwork?: boolean;
  headers?: Record<string, string>;
}

export interface PreparedImport {
  format: ImportFormat;
  source: string;
  entries: KnowledgeEntry[];
}

const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WEB_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_IMPORT_DOCUMENTS = 10_000;

interface SourceDocument {
  title: string;
  body: string;
  date?: string;
  workspace?: string;
  agent?: string;
  category?: string;
  tags?: string[];
  summary?: string;
  id?: string;
}

interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function cleanTitle(value: string): string {
  return value.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
}

function parseFrontmatter(content: string): Frontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return { data: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: normalized };

  const data: Record<string, string | string[]> = {};
  const lines = normalized.slice(4, end).split("\n");
  let listKey: string | undefined;
  for (const line of lines) {
    const listItem = line.match(/^\s+-\s+(.+?)\s*$/);
    if (listItem && listKey) {
      const current = data[listKey];
      const items = Array.isArray(current) ? current : [];
      items.push(unquote(listItem[1]));
      data[listKey] = items;
      continue;
    }

    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!field) {
      listKey = undefined;
      continue;
    }
    const key = field[1].toLowerCase();
    const rawValue = field[2];
    if (!rawValue) {
      listKey = key;
      data[key] = [];
    } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      data[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
      listKey = undefined;
    } else {
      data[key] = unquote(rawValue);
      listKey = undefined;
    }
  }

  return {
    data,
    body: normalized.slice(end + 4).replace(/^\s*\n/, ""),
  };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((item) => item.replace(/^#/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function inferCategory(title: string, body: string): KnowledgeEntry["category"] {
  const combined = `${title}\n${body}`;
  if (/\b(decision|decided|architecture|chosen|trade.?off)\b/i.test(combined)) {
    return "decision";
  }
  if (/\b(finding|discovered|root cause|bug|regression|investigation)\b/i.test(combined)) {
    return "finding";
  }
  return "work-log";
}

function sourceEntry(
  document: SourceDocument,
  source: string,
  sourceId: string,
  options: ImportOptions,
  defaultWorkspace: string,
): KnowledgeEntry {
  const date = options.date ?? document.date ?? localDate();
  if (!isDate(date)) {
    throw new Error(`invalid imported date "${date}" (expected YYYY-MM-DD)`);
  }

  const categoryValue = document.category?.toLowerCase();
  const category =
    categoryValue === "finding" ||
    categoryValue === "decision" ||
    categoryValue === "work-log"
      ? categoryValue
      : inferCategory(document.title, document.body);
  const tags = [
    ...new Set([
      ...(document.tags ?? []).map((tag) => tag.replace(/^#/, "").trim()),
      ...deriveAutomaticTags(document.title, document.body),
    ]),
  ].slice(0, 12);
  const workspace = options.workspace
    ? tildifyPath(resolvePath(options.workspace))
    : document.workspace ??
      (defaultWorkspace.startsWith("http://") ||
      defaultWorkspace.startsWith("https://")
        ? defaultWorkspace
        : tildifyPath(resolvePath(defaultWorkspace)));

  return {
    date,
    title: cleanTitle(document.title) || "Imported knowledge",
    workspace,
    agent: options.agent ?? document.agent ?? "Scribe Import",
    category,
    body: document.body.trim(),
    source,
    sourceId,
    ...(document.summary ? { summary: document.summary } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function markdownDocument(
  content: string,
  filePath: string,
  sourceRoot: string,
  options: ImportOptions,
  sourceFormat = "markdown",
): KnowledgeEntry {
  const frontmatter = parseFrontmatter(content);
  const data = frontmatter.data;
  const relativePath = safeRelativePath(relative(sourceRoot, filePath)) || basename(filePath);
  const title =
    asString(data.title) ||
    cleanTitle(frontmatter.body.match(/^#\s+(.+)$/m)?.[1] ?? "") ||
    basename(filePath, extname(filePath));
  const tags = asStringArray(data.tags);
  const sourcePrefix = `${sourceFormat}:${digest(resolve(sourceRoot)).slice(0, 12)}`;
  const sourceId = `${sourcePrefix}:${asString(data.id) ?? relativePath}`;

  return sourceEntry(
    {
      title,
      body: frontmatter.body,
      date: asString(data.date),
      workspace: asString(data.workspace),
      agent: asString(data.agent),
      category: asString(data.category),
      tags,
      summary: asString(data.summary) ?? asString(data.description),
    },
    `${sourceFormat}:${relativePath}`,
    sourceId,
    options,
    sourceRoot,
  );
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, value: string) => {
    if (value.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(value.slice(2), 16));
    }
    if (value.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(value.slice(1), 10));
    }
    return named[value.toLowerCase()] ?? entity;
  });
}

function htmlToMarkdown(html: string): { title?: string; body: string } {
  const title = decodeEntities(
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
      html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
      "",
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n### $1\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|blockquote|tr|table|ul|ol)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  body = decodeEntities(body)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { ...(title ? { title } : {}), body };
}

function nestedConfluenceBody(value: Record<string, unknown>): string | undefined {
  const body = value.body;
  if (!body || typeof body !== "object") return undefined;
  const bodyObject = body as Record<string, unknown>;
  for (const representation of ["storage", "view", "export_view"]) {
    const item = bodyObject[representation];
    if (item && typeof item === "object") {
      const html = asString((item as Record<string, unknown>).value);
      if (html) return htmlToMarkdown(html).body;
    }
  }
  return undefined;
}

function jsonDocument(
  value: Record<string, unknown>,
  index: number,
  source: string,
  options: ImportOptions,
  defaultWorkspace: string,
): KnowledgeEntry {
  const title =
    asString(value.title) ??
    asString(value.name) ??
    asString(value.summary) ??
    `Imported record ${index + 1}`;
  const bodyValue =
    asString(value.body) ??
    asString(value.content) ??
    asString(value.markdown) ??
    asString(value.text) ??
    nestedConfluenceBody(value) ??
    "";
  const body =
    /<\/?[a-z][\s\S]*>/i.test(bodyValue)
      ? htmlToMarkdown(bodyValue).body
      : bodyValue;
  const version =
    value.version && typeof value.version === "object"
      ? (value.version as Record<string, unknown>)
      : undefined;
  const id =
    asString(value.sourceId) ??
    asString(value.id) ??
    `${source}#${index + 1}`;
  const date =
    asString(value.date) ??
    asString(value.createdAt)?.slice(0, 10) ??
    asString(value.created_at)?.slice(0, 10) ??
    asString(version?.when)?.slice(0, 10);

  return sourceEntry(
    {
      title,
      body,
      date,
      workspace: asString(value.workspace),
      agent: asString(value.agent),
      category: asString(value.category),
      tags: asStringArray(value.tags),
      summary: asString(value.summary),
    },
    source,
    `json:${digest(`${source}\0${id}`).slice(0, 32)}`,
    options,
    defaultWorkspace,
  );
}

function jsonRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    );
  }
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["entries", "records", "documents", "results", "pages"]) {
    if (Array.isArray(object[key])) {
      return jsonRecords(object[key]);
    }
  }
  return [object];
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    const children = readdirSync(directory, { withFileTypes: true });
    for (const child of children) {
      if (
        child.name.startsWith(".") ||
        ["node_modules", "dist", "vendor"].includes(child.name)
      ) {
        continue;
      }
      const fullPath = join(directory, child.name);
      if (child.isDirectory()) stack.push(fullPath);
      else if (child.isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

function supportedFile(filePath: string): ImportFormat | undefined {
  switch (extname(filePath).toLowerCase()) {
    case ".md":
    case ".markdown":
    case ".mdx":
      return "markdown";
    case ".json":
      return "json";
    case ".jsonl":
    case ".ndjson":
      return "jsonl";
    case ".txt":
      return "text";
    case ".html":
    case ".htm":
      return "html";
    default:
      return undefined;
  }
}

function importLocalFile(
  filePath: string,
  sourceRoot: string,
  format: ImportFormat,
  options: ImportOptions,
): KnowledgeEntry[] {
  const info = statSync(filePath);
  if (info.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`source file exceeds ${MAX_SOURCE_FILE_BYTES} bytes`);
  }
  const content = readFileSync(filePath, "utf8");
  const relativePath = safeRelativePath(relative(sourceRoot, filePath)) || basename(filePath);
  const sourceId = `${digest(resolve(sourceRoot)).slice(0, 12)}:${relativePath}`;

  if (format === "markdown") {
    return [markdownDocument(content, filePath, sourceRoot, options)];
  }

  if (format === "text") {
    return [
      sourceEntry(
        { title: basename(filePath, extname(filePath)), body: content },
        `text:${relativePath}`,
        `text:${sourceId}`,
        options,
        sourceRoot,
      ),
    ];
  }

  if (format === "html") {
    const parsed = htmlToMarkdown(content);
    return [
      sourceEntry(
        {
          title: parsed.title ?? basename(filePath, extname(filePath)),
          body: parsed.body,
        },
        `html:${relativePath}`,
        `html:${sourceId}`,
        options,
        sourceRoot,
      ),
    ];
  }

  if (format === "jsonl") {
    let recordIndex = 0;
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const value = JSON.parse(line) as unknown;
        return jsonRecords(value).map((record) =>
          jsonDocument(
            record,
            recordIndex++,
            `jsonl:${digest(resolve(sourceRoot)).slice(0, 12)}:${relativePath}`,
            options,
            sourceRoot,
          ),
        );
      });
  }

  if (format === "json") {
    const value = JSON.parse(content) as unknown;
    return jsonRecords(value).map((record, index) =>
      jsonDocument(
        record,
        index,
        `json:${digest(resolve(sourceRoot)).slice(0, 12)}:${relativePath}`,
        options,
        sourceRoot,
      ),
    );
  }

  throw new Error(`unsupported local import format: ${format}`);
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith("ff")
    ) {
      return true;
    }
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true;
}

async function assertSafeUrl(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("web imports only support HTTP and HTTPS URLs");
  }
  if (url.username || url.password) {
    throw new Error("credentials in URL user-info are not allowed");
  }
  if (allowPrivateNetwork) return;

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".test")
  ) {
    throw new Error("private network URL blocked; use --allow-private-network if intentional");
  }

  const family = isIP(hostname);
  if (family) {
    if (isPrivateAddress(hostname)) {
      throw new Error("private network URL blocked; use --allow-private-network if intentional");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("URL resolves to a private network address");
  }
}

function importHeadersFromEnvironment(): Record<string, string> {
  const raw = process.env.SCRIBE_IMPORT_HEADERS;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SCRIBE_IMPORT_HEADERS must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SCRIBE_IMPORT_HEADERS must be a JSON object");
  }

  const headers: Record<string, string> = {};
  const forbidden = new Set([
    "connection",
    "content-length",
    "host",
    "transfer-encoding",
  ]);
  for (const [name, value] of Object.entries(parsed)) {
    if (
      typeof value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      forbidden.has(name.toLowerCase())
    ) {
      throw new Error("import headers contain an invalid or forbidden value");
    }
    headers[name] = value;
  }
  return headers;
}

async function readResponseBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_WEB_RESPONSE_BYTES) {
    throw new Error(`web response exceeds ${MAX_WEB_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_WEB_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`web response exceeds ${MAX_WEB_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchWebDocument(
  initialUrl: string,
  options: ImportOptions,
): Promise<{ url: string; format: "html" | "json" | "text"; content: string }> {
  let url = new URL(initialUrl);
  const headers = { ...(options.headers ?? importHeadersFromEnvironment()) };
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    await assertSafeUrl(url, options.allowPrivateNetwork ?? false);
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`web response redirect ${response.status} has no location`);
      if (redirectCount === 5) throw new Error("too many web redirects");
      const nextUrl = new URL(location, url);
      if (
        nextUrl.host !== url.host ||
        (url.protocol === "https:" && nextUrl.protocol === "http:")
      ) {
        for (const name of Object.keys(headers)) {
          if (!["accept", "user-agent"].includes(name.toLowerCase())) {
            delete headers[name];
          }
        }
      }
      url = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`web request failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const format = contentType.includes("json")
      ? "json"
      : contentType.includes("html")
        ? "html"
        : "text";
    return { url: url.toString(), format, content: await readResponseBody(response) };
  }
  throw new Error("too many web redirects");
}

function importWebResponse(
  response: { url: string; format: "html" | "json" | "text"; content: string },
  options: ImportOptions,
): KnowledgeEntry[] {
  if (response.format === "html") {
    const parsed = htmlToMarkdown(response.content);
    const description = response.content.match(
      /<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    )?.[1];
    return [
      sourceEntry(
        {
          title: parsed.title ?? response.url,
          body: parsed.body,
          workspace: new URL(response.url).origin,
          summary: description ? decodeEntities(description) : undefined,
        },
        response.url,
        `url:${digest(response.url)}`,
        options,
        new URL(response.url).origin,
      ),
    ];
  }
  if (response.format === "json") {
    const value = JSON.parse(response.content) as unknown;
    return jsonRecords(value).map((record, index) =>
      jsonDocument(
        record,
        index,
        response.url,
        options,
        new URL(response.url).origin,
      ),
    );
  }
  return [
    sourceEntry(
      {
        title: response.url,
        body: response.content,
        workspace: new URL(response.url).origin,
      },
      response.url,
      `url:${digest(response.url)}`,
      options,
      new URL(response.url).origin,
    ),
  ];
}

function importGitHistory(
  repoPath: string,
  options: ImportOptions,
): KnowledgeEntry[] {
  const absoluteRepo = resolvePath(repoPath);
  const check = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: absoluteRepo,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const args = [
    "log",
    "--all",
    "--no-merges",
    `--max-count=${limit}`,
    "--format=%H",
  ];
  if (options.since) {
    if (!isDate(options.since)) {
      throw new Error(`invalid --since date "${options.since}"`);
    }
    args.push(`--since=${options.since}`);
  }
  const commits = execFileSync("git", args, {
    cwd: check,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: "pipe",
  })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f]{40,64}$/i.test(value));

  return commits.map((commit) => {
    const metadata = execFileSync(
      "git",
      ["show", "-s", "--format=%cs%x00%s%x00%b", commit],
      {
        cwd: check,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: "pipe",
      },
    );
    const [date, subject, ...bodyParts] = metadata.split("\0");
    const files = execFileSync(
      "git",
      ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit],
      {
        cwd: check,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: "pipe",
      },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const body = [
      bodyParts.join("\0").trim(),
      files.length > 0 ? `Files: ${files.slice(0, 20).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const relativeRepo = tildifyPath(check);
    return sourceEntry(
      {
        title: subject || `Commit ${commit.slice(0, 12)}`,
        body,
        date: options.date ?? date,
        category: undefined,
      },
      `git:${commit.slice(0, 12)}`,
      `git:${digest(check).slice(0, 12)}:${commit}`,
      options,
      options.workspace ?? relativeRepo,
    );
  });
}

export async function prepareImport(
  options: ImportOptions,
): Promise<PreparedImport> {
  const source = options.source;
  const format = options.format ?? "auto";
  const isUrl = /^https?:\/\//i.test(source);
  const entryLimit = Math.min(
    Math.max(options.limit ?? MAX_IMPORT_DOCUMENTS, 1),
    MAX_IMPORT_DOCUMENTS,
  );

  if (format === "url" || isUrl) {
    const response = await fetchWebDocument(source, options);
    return {
      format: "url",
      source: response.url,
      entries: importWebResponse(response, options).slice(0, entryLimit),
    };
  }

  if (format === "git") {
    return {
      format: "git",
      source: resolvePath(source),
      entries: importGitHistory(source, {
        ...options,
        limit: Math.min(options.limit ?? 100, 1000),
      }).slice(0, entryLimit),
    };
  }

  const sourcePath = resolvePath(source);
  const info = statSync(sourcePath);
  if (info.isDirectory()) {
    const files = walkFiles(sourcePath)
      .filter((file) => {
        const detected = supportedFile(file);
        return format === "auto" ? Boolean(detected) : detected === format;
      })
      .slice(0, entryLimit);
    let totalBytes = 0;
    for (const file of files) {
      const size = statSync(file).size;
      if (size > MAX_SOURCE_FILE_BYTES) {
        throw new Error(`source file exceeds ${MAX_SOURCE_FILE_BYTES} bytes`);
      }
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_IMPORT_BYTES) {
        throw new Error(`import exceeds ${MAX_TOTAL_IMPORT_BYTES} total bytes`);
      }
    }
    const entries = files.flatMap((file) => {
      const detected = format === "auto" ? supportedFile(file) : format;
      if (!detected || detected === "git" || detected === "url") return [];
      return importLocalFile(file, sourcePath, detected, options);
    });
    return { format, source: sourcePath, entries: entries.slice(0, entryLimit) };
  }

  if (info.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`source file exceeds ${MAX_SOURCE_FILE_BYTES} bytes`);
  }
  const detected = format === "auto" ? supportedFile(sourcePath) : format;
  if (!detected || detected === "git" || detected === "url") {
    throw new Error(`cannot determine import format for ${basename(sourcePath)}`);
  }
  return {
    format: detected,
    source: sourcePath,
    entries: importLocalFile(
      sourcePath,
      dirname(sourcePath),
      detected,
      options,
    ).slice(0, entryLimit),
  };
}

export function importHeadersFromEnv(): Record<string, string> {
  return importHeadersFromEnvironment();
}
