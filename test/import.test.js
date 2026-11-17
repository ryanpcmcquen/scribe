"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createServer } = require("node:http");
const {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { prepareImport } = require("../dist/import/index.js");
const { parseJson, runCli } = require("./helpers");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "scribe-import-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Markdown and Obsidian folder import preserves provenance and extracts metadata", async (t) => {
  const dir = tempDir(t);
  const notes = join(dir, "notes");
  mkdirSync(join(notes, "guides"), { recursive: true });
  writeFileSync(
    join(notes, "guides", "rebase.md"),
    [
      "---",
      "title: Git rebase workflow",
      "date: 2026-11-17",
      "category: decision",
      "tags:",
      "  - git",
      "  - workflow",
      "summary: Keep concurrent journal writes recoverable.",
      "---",
      "",
      "# Git rebase workflow",
      "",
      "Rebase local journal entries before retrying a rejected push.",
      "",
      "### Troubleshooting",
      "",
      "- **Agent:** This is body text, not Scribe metadata.",
      "",
    ].join("\n"),
  );

  const imported = await prepareImport({ source: notes });
  assert.equal(imported.format, "auto");
  assert.equal(imported.entries.length, 1);
  const [entry] = imported.entries;
  assert.equal(entry.title, "Git rebase workflow");
  assert.equal(entry.date, "2026-11-17");
  assert.equal(entry.category, "decision");
  assert.deepEqual(entry.tags.slice(0, 2), ["git", "workflow"]);
  assert.equal(entry.summary, "Keep concurrent journal writes recoverable.");
  assert.match(entry.body, /### Troubleshooting/);
  assert.match(entry.body, /This is body text, not Scribe metadata/);
  assert.equal(entry.source, "markdown:guides/rebase.md");
  assert.match(entry.sourceId, /^markdown:[a-f0-9]{12}:guides\/rebase\.md$/);
});

test("JSON and JSONL import normalize common record fields", async (t) => {
  const dir = tempDir(t);
  const jsonPath = join(dir, "confluence-export.json");
  writeFileSync(
    jsonPath,
    JSON.stringify({
      results: [
        {
          id: "page-123",
          title: "Confluence page",
          version: { when: "2026-11-15T10:30:00Z" },
          body: {
            storage: {
              value: "<h1>Page heading</h1><p>Confluence content.</p>",
            },
          },
        },
      ],
    }),
  );

  const jsonImport = await prepareImport({ source: jsonPath });
  assert.equal(jsonImport.entries.length, 1);
  assert.equal(jsonImport.entries[0].title, "Confluence page");
  assert.equal(jsonImport.entries[0].date, "2026-11-15");
  assert.match(jsonImport.entries[0].body, /Confluence content/);
  assert.match(jsonImport.entries[0].sourceId, /^json:/);

  const jsonlPath = join(dir, "entries.jsonl");
  writeFileSync(
    jsonlPath,
    [
      JSON.stringify({
        id: "row-1",
        title: "First record",
        body: "First body",
        date: "2026-11-16",
      }),
      JSON.stringify({
        id: "row-2",
        title: "Second record",
        body: "Second body",
        date: "2026-11-17",
      }),
    ].join("\n"),
  );
  const jsonlImport = await prepareImport({ source: jsonlPath });
  assert.equal(jsonlImport.format, "jsonl");
  assert.deepEqual(
    jsonlImport.entries.map((entry) => entry.title),
    ["First record", "Second record"],
  );
  assert.notEqual(
    jsonlImport.entries[0].sourceId,
    jsonlImport.entries[1].sourceId,
  );
});

test("plain text and HTML file imports produce readable Markdown bodies", async (t) => {
  const dir = tempDir(t);
  const textPath = join(dir, "notes.txt");
  const htmlPath = join(dir, "page.html");
  writeFileSync(textPath, "Plain text knowledge.\nSecond line.");
  writeFileSync(
    htmlPath,
    [
      "<html><head><title>HTML title</title></head><body>",
      "<script>ignoredSecret()</script>",
      "<h1>Main heading</h1><p>HTML paragraph.</p>",
      "<ul><li>First item</li><li>Second item</li></ul>",
      "</body></html>",
    ].join(""),
  );

  const textImport = await prepareImport({ source: textPath });
  assert.equal(textImport.entries[0].title, "notes");
  assert.match(textImport.entries[0].body, /Plain text knowledge/);

  const htmlImport = await prepareImport({ source: htmlPath });
  assert.equal(htmlImport.entries[0].title, "HTML title");
  assert.match(htmlImport.entries[0].body, /### Main heading/);
  assert.match(htmlImport.entries[0].body, /- First item/);
  assert.doesNotMatch(htmlImport.entries[0].body, /ignoredSecret/);
});

test("URL import rejects private addresses unless explicitly allowed", async (t) => {
  await assert.rejects(
    () => prepareImport({ source: "http://127.0.0.1/internal" }),
    /private network URL blocked/,
  );

  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-import-token");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<html><head><title>Internal guide</title></head><body><p>Useful imported content.</p></body></html>",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const imported = await prepareImport({
    source: `http://127.0.0.1:${address.port}/guide`,
    allowPrivateNetwork: true,
    headers: { Authorization: "Bearer test-import-token" },
  });
  assert.equal(imported.format, "url");
  assert.equal(imported.entries[0].title, "Internal guide");
  assert.equal(imported.entries[0].workspace, `http://127.0.0.1:${address.port}`);
  assert.doesNotMatch(JSON.stringify(imported), /test-import-token/);
});

test("Git history import converts commits to provenance-tagged entries", async (t) => {
  const dir = tempDir(t);
  const init = spawnSync("git", ["init", "-b", "main", dir], {
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  const projectFile = join(dir, "README.md");
  writeFileSync(projectFile, "Imported project history.\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Scribe Import Test",
    GIT_AUTHOR_EMAIL: "import@example.test",
    GIT_COMMITTER_NAME: "Scribe Import Test",
    GIT_COMMITTER_EMAIL: "import@example.test",
  };
  for (const args of [
    ["git", "add", "README.md"],
    ["git", "commit", "-m", "Document project history"],
  ]) {
    const result = spawnSync(args[0], args.slice(1), {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const imported = await prepareImport({ source: dir, format: "git" });
  assert.equal(imported.entries.length, 1);
  assert.equal(imported.entries[0].title, "Document project history");
  assert.match(imported.entries[0].sourceId, /^git:[a-f0-9]{12}:/);
  assert.match(imported.entries[0].body, /README\.md/);
});

test("scribe import dry-run and batch import are local, idempotent, and commit once", (t) => {
  const dir = tempDir(t);
  const source = join(dir, "source");
  const workspace = join(dir, "journal");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "note.md"),
    [
      "---",
      "title: Imported note",
      "date: 2026-11-17",
      "tags: [local, markdown]",
      "---",
      "",
      "A source note body.",
      "",
      "### Nested source heading",
      "",
      "- **Agent:** This content belongs to the imported note body.",
      "",
    ].join("\n"),
  );
  const env = {
    SCRIBE_CONFIG: join(dir, "config.json"),
    SCRIBE_WORKSPACE: workspace,
    GIT_AUTHOR_NAME: "Scribe Import Test",
    GIT_AUTHOR_EMAIL: "import@example.test",
    GIT_COMMITTER_NAME: "Scribe Import Test",
    GIT_COMMITTER_EMAIL: "import@example.test",
  };

  const init = runCli(["init", "--workspace", workspace, "--json"], { env });
  assert.equal(init.status, 0, init.stderr);

  const dryRun = runCli(["import", source, "--dry-run", "--json"], { env });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(parseJson(dryRun).entries, 1);
  assert.equal(parseJson(dryRun).dryRun, true);
  assert.deepEqual(
    parseJson(runCli(["read", "--all", "--json"], { env })).entries,
    [],
  );

  const first = runCli(["import", source, "--json"], { env });
  assert.equal(first.status, 0, first.stderr);
  const firstResult = parseJson(first);
  assert.equal(firstResult.created, 1);
  assert.equal(firstResult.committed, true);

  const second = runCli(["import", source, "--json"], { env });
  assert.equal(second.status, 0, second.stderr);
  const secondResult = parseJson(second);
  assert.equal(secondResult.created, 0);
  assert.equal(secondResult.deduplicated, 1);
  assert.equal(secondResult.committed, false);

  const read = parseJson(runCli(["read", "--all", "--json"], { env }));
  assert.equal(read.entries.length, 1);
  assert.match(read.entries[0].body, /A source note body/);
  assert.match(read.entries[0].body, /### Nested source heading/);
  assert.match(
    read.entries[0].body,
    /This content belongs to the imported note body/,
  );
  assert.ok(read.entries[0].tags.includes("markdown"));
});
