"use strict";

const assert = require("node:assert/strict");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative } = require("node:path");
const test = require("node:test");

const ROOT = join(__dirname, "..");

function walkFiles(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    if (
      entry === ".git" ||
      entry === "node_modules" ||
      entry === "dist" ||
      entry === ".DS_Store"
    ) {
      continue;
    }
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkFiles(fullPath, results);
    } else if (/\.(ts|js|md|yml|yaml|json)$/.test(entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

test("repository files contain no literal home paths", () => {
  const files = walkFiles(ROOT).filter(
    (file) => relative(ROOT, file) !== "test/style.test.js",
  );
  const homePattern = new RegExp(
    "/(Users|home)/[A-Za-z0-9._-]+",
  );

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const match = content.match(homePattern);
    assert.equal(
      match,
      null,
      `Found literal home path in ${relative(ROOT, file)}: ${match?.[0]}`,
    );
  }
});

test("source, tests, and docs contain no end-of-line comments", () => {
  const files = walkFiles(ROOT).filter((file) => {
    const rel = relative(ROOT, file);
    return (
      rel !== "test/style.test.js" &&
      rel !== "package-lock.json" &&
      /\.(ts|js|md)$/.test(rel)
    );
  });

  const trailingSlashComment = /\S\s+\/\/\s/;
  const trailingHashComment = /\S\s+#\s/;

  for (const file of files) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/\.(ts|js)$/.test(rel)) {
        assert.equal(
          trailingSlashComment.test(line),
          false,
          `Found end-of-line comment in ${rel}:${index + 1}: ${line}`,
        );
      }
      if (/\.md$/.test(rel)) {
        assert.equal(
          trailingHashComment.test(line),
          false,
          `Found end-of-line comment in ${rel}:${index + 1}: ${line}`,
        );
      }
    });
  }
});
