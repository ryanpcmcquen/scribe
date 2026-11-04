"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ScribeMcpServer } = require("../dist/mcp/index.js");
const { parseJson, runCli, tempDir } = require("./helpers");

test("ScribeMcpServer lists tools, captures entries, and reads resources", async (t) => {
  const dir = tempDir(t);
  const workspace = `${dir}/journal`;
  const server = new ScribeMcpServer({
    workspace,
    agent: "OpenCode",
    autoCommit: false,
    autoPush: false,
  });

  const initRes = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(initRes.result.serverInfo.name, "scribe");

  const toolsRes = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.deepEqual(
    toolsRes.result.tools.map((tool) => tool.name),
    ["scribe_capture", "scribe_read", "scribe_reminders", "scribe_focus"],
  );

  const captureRes = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "scribe_capture",
      arguments: {
        title: "MCP capture works",
        category: "decision",
        workspace: `${dir}/project`,
        body: "Captured over MCP.",
      },
    },
  });
  const capturedPayload = JSON.parse(captureRes.result.content[0].text);
  assert.equal(capturedPayload.ok, true);
  assert.equal(capturedPayload.entry.title, "MCP capture works");

  const readRes = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "scribe_read",
      arguments: { workspace: `${dir}/project` },
    },
  });
  const readPayload = JSON.parse(readRes.result.content[0].text);
  assert.equal(readPayload.entries.length, 1);
  assert.equal(readPayload.entries[0].title, "MCP capture works");

  const resourceRes = await server.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "resources/read",
    params: { uri: "scribe://focus/current" },
  });
  const resourcePayload = JSON.parse(resourceRes.result.contents[0].text);
  assert.equal(resourcePayload.items.length, 1);
  assert.equal(resourcePayload.items[0].score, 3);
});

test("scribe mcp CLI handles both newline-delimited and Content-Length JSON-RPC", (t) => {
  const dir = tempDir(t);
  const env = {
    SCRIBE_CONFIG: `${dir}/config.json`,
    SCRIBE_WORKSPACE: `${dir}/journal`,
    SCRIBE_AUTO_COMMIT: "false",
    SCRIBE_AUTO_PUSH: "false",
  };

  const newlineResult = runCli(["mcp"], {
    env,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
  });
  assert.equal(newlineResult.status, 0, newlineResult.stderr);
  assert.deepEqual(parseJson(newlineResult), {
    jsonrpc: "2.0",
    id: 1,
    result: {},
  });

  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const framedInput = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  const framedResult = runCli(["mcp"], { env, input: framedInput });
  assert.equal(framedResult.status, 0, framedResult.stderr);
  assert.match(framedResult.stdout, /^Content-Length: \d+\r\n\r\n/);
  const jsonPart = framedResult.stdout.split("\r\n\r\n")[1];
  const parsed = JSON.parse(jsonPart);
  assert.equal(parsed.id, 2);
  assert.equal(parsed.result.tools.length, 4);
});
