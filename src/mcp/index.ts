import {
  ConfigOverrides,
  loadConfig,
  resolvePath,
  ScribeConfig,
  tildifyPath,
} from "../config";
import { currentMonth, isDate, isMonth, localDate } from "../date";
import { Scribe } from "../scribe";
import {
  effectiveReminderStatus,
  KnowledgeEntry,
  ReminderEntry,
  ReminderStatus,
  ScribeEntry,
} from "../storage";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const MCP_TOOLS = [
  {
    name: "scribe_capture",
    description:
      "Record an engineering finding, architectural decision, work-log entry, or pending reminder into the Scribe markdown knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["knowledge", "reminder"],
          description: "Entry type (defaults to 'knowledge', or 'reminder' if priority/context/action are set).",
        },
        title: {
          type: "string",
          description: "Short, factual entry title.",
        },
        category: {
          type: "string",
          enum: ["finding", "decision", "work-log"],
          description: "Knowledge category (defaults to 'work-log').",
        },
        body: {
          type: "string",
          description: "Concise markdown body describing context, rationale, or work completed.",
        },
        workspace: {
          type: "string",
          description: "Repository or workspace path the entry applies to.",
        },
        agent: {
          type: "string",
          description: "Capturing CLI or agent name.",
        },
        date: {
          type: "string",
          description: "Optional local date in YYYY-MM-DD format (defaults to today).",
        },
        priority: {
          type: "string",
          enum: ["p1", "p2", "p3"],
          description: "Reminder priority when recording a reminder.",
        },
        context: {
          type: "string",
          description: "Why the reminder is pending.",
        },
        action: {
          type: "string",
          description: "Actionable pending item for a reminder.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "scribe_read",
    description:
      "Read accumulated Scribe knowledge entries for a specific month or across all months, optionally filtered to one workspace.",
    inputSchema: {
      type: "object",
      properties: {
        month: {
          type: "string",
          description: "Month in YYYY-MM format (defaults to current month unless all is true).",
        },
        all: {
          type: "boolean",
          description: "Read across all recorded months.",
        },
        workspace: {
          type: "string",
          description: "Optional workspace path filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scribe_reminders",
    description:
      "Read Scribe reminders or update a reminder's lifecycle status (done, snooze, reopen).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "done", "snooze", "reopen"],
          description: "Lifecycle action (defaults to 'list').",
        },
        title: {
          type: "string",
          description: "Reminder title or substring query when action is done, snooze, or reopen.",
        },
        until: {
          type: "string",
          description: "Snooze date in YYYY-MM-DD format when action is 'snooze'.",
        },
        status: {
          type: "string",
          enum: ["pending", "done", "snoozed", "all"],
          description: "Filter listed reminders by effective status.",
        },
        month: {
          type: "string",
          description: "Month in YYYY-MM format (defaults to current month unless all is true).",
        },
        all: {
          type: "boolean",
          description: "Read across all recorded months.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scribe_focus",
    description:
      "Rank Scribe knowledge entries and active reminders by priority weight for a focus brief.",
    inputSchema: {
      type: "object",
      properties: {
        month: {
          type: "string",
          description: "Month in YYYY-MM format (defaults to current month unless all is true).",
        },
        all: {
          type: "boolean",
          description: "Rank across all recorded months.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scribe_search",
    description:
      "Search across months over Scribe knowledge entries and reminders by keyword, workspace, category, or status.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keywords or phrase.",
        },
        workspace: {
          type: "string",
          description: "Optional workspace path filter.",
        },
        category: {
          type: "string",
          enum: ["finding", "decision", "work-log"],
          description: "Optional knowledge category filter.",
        },
        status: {
          type: "string",
          enum: ["pending", "done", "snoozed", "all"],
          description: "Optional reminder status filter.",
        },
        kind: {
          type: "string",
          enum: ["all", "knowledge", "reminders"],
          description: "Entry kind to search (defaults to 'all').",
        },
        month: {
          type: "string",
          description: "Optional month filter in YYYY-MM format.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (defaults to 20).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scribe_context",
    description:
      "Retrieve a compact, high-signal Scribe context pack (decisions, findings, recent work, and pending reminders) for a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path to scope context to.",
        },
        query: {
          type: "string",
          description: "Optional task query to rank relevant entries.",
        },
        limit: {
          type: "number",
          description: "Maximum items per section (defaults to 5).",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

export const MCP_RESOURCES = [
  {
    uri: "scribe://knowledge/current",
    name: "Current month Scribe knowledge",
    description: "Knowledge entries recorded in the current calendar month.",
    mimeType: "application/json",
  },
  {
    uri: "scribe://reminders/current",
    name: "Current month Scribe reminders",
    description: "Reminders recorded in the current calendar month.",
    mimeType: "application/json",
  },
  {
    uri: "scribe://focus/current",
    name: "Current month Scribe focus ranking",
    description: "Ranked focus items from the current calendar month.",
    mimeType: "application/json",
  },
] as const;

function buildMcpEntry(
  args: Record<string, unknown>,
  config: ScribeConfig,
): ScribeEntry {
  const date = typeof args.date === "string" && args.date ? args.date : localDate();
  if (!isDate(date)) {
    throw new Error(`invalid date "${date}" (expected YYYY-MM-DD)`);
  }

  const title = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim() : "";
  if (!title) {
    throw new Error("a title is required");
  }

  const inferredReminder =
    args.priority !== undefined ||
    args.context !== undefined ||
    args.action !== undefined;
  const kind =
    typeof args.type === "string"
      ? args.type
      : inferredReminder
        ? "reminder"
        : "knowledge";

  if (kind !== "knowledge" && kind !== "reminder") {
    throw new Error(`invalid type "${kind}" (expected knowledge or reminder)`);
  }

  if (kind === "reminder") {
    const priority = typeof args.priority === "string" ? args.priority : "p2";
    if (!["p1", "p2", "p3"].includes(priority)) {
      throw new Error(`invalid priority "${priority}" (expected p1, p2, or p3)`);
    }
    return {
      date,
      title,
      priority: priority as ReminderEntry["priority"],
      context: typeof args.context === "string" ? args.context : "",
      action:
        typeof args.action === "string"
          ? args.action
          : typeof args.body === "string"
            ? args.body
            : "",
    };
  }

  const category = typeof args.category === "string" ? args.category : "work-log";
  if (!["finding", "decision", "work-log"].includes(category)) {
    throw new Error(
      `invalid category "${category}" (expected finding, decision, or work-log)`,
    );
  }

  const rawWorkspace =
    typeof args.workspace === "string" && args.workspace.trim()
      ? args.workspace
      : process.cwd();

  return {
    date,
    title,
    workspace: tildifyPath(resolvePath(rawWorkspace)),
    agent:
      typeof args.agent === "string" && args.agent.trim()
        ? args.agent.trim()
        : config.agent,
    category: category as KnowledgeEntry["category"],
    body: typeof args.body === "string" ? args.body : "",
  };
}

export class ScribeMcpServer {
  constructor(private readonly overrides: ConfigOverrides = {}) {}

  private resolveConfig(): ScribeConfig {
    return loadConfig(this.overrides);
  }

  private createScribe(config: ScribeConfig, readOnly = false): Scribe {
    return new Scribe({
      workspacePath: config.workspace,
      remote: config.remote,
      autoCommit: readOnly ? false : config.autoCommit,
      autoPush: readOnly ? false : config.autoPush,
    });
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = request.id ?? null;
    const isNotification = request.id === undefined;

    try {
      switch (request.method) {
        case "initialize": {
          const requestedVersion =
            typeof request.params?.protocolVersion === "string"
              ? request.params.protocolVersion
              : "2024-11-05";
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: requestedVersion,
              capabilities: {
                tools: {},
                resources: {},
              },
              serverInfo: {
                name: "scribe",
                version: "0.1.0",
              },
            },
          };
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          return null;

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: { tools: MCP_TOOLS },
          };

        case "tools/call": {
          const name =
            typeof request.params?.name === "string" ? request.params.name : "";
          const rawArgs = request.params?.arguments;
          const args =
            rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};

          const toolResult = await this.callTool(name, args);
          return {
            jsonrpc: "2.0",
            id,
            result: toolResult,
          };
        }

        case "resources/list":
          return {
            jsonrpc: "2.0",
            id,
            result: { resources: MCP_RESOURCES },
          };

        case "resources/read": {
          const uri =
            typeof request.params?.uri === "string" ? request.params.uri : "";
          const contents = this.readResource(uri);
          return {
            jsonrpc: "2.0",
            id,
            result: { contents },
          };
        }

        default:
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${request.method}`,
            },
          };
      }
    } catch (error) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    try {
      const config = this.resolveConfig();

      switch (name) {
        case "scribe_capture": {
          const entry = buildMcpEntry(args, config);
          const scribe = this.createScribe(config, false);
          const result = await scribe.record(entry);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, entry, ...result }, null, 2),
              },
            ],
          };
        }

        case "scribe_read": {
          const all = args.all === true;
          const month =
            typeof args.month === "string" && args.month ? args.month : undefined;
          if (month && !isMonth(month)) {
            throw new Error(`invalid month "${month}" (expected YYYY-MM)`);
          }
          const workspaceFilter =
            typeof args.workspace === "string" && args.workspace.trim()
              ? tildifyPath(resolvePath(args.workspace))
              : undefined;

          const scribe = this.createScribe(config, true);
          let entries = all
            ? scribe.readAllKnowledge()
            : scribe.readKnowledge(month);
          if (workspaceFilter) {
            entries = entries.filter(
              (entry) => entry.workspace === workspaceFilter,
            );
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: true,
                    month: all ? null : month ?? currentMonth(),
                    entries,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "scribe_reminders": {
          const action =
            typeof args.action === "string" && args.action ? args.action : "list";
          const month =
            typeof args.month === "string" && args.month ? args.month : undefined;
          if (month && !isMonth(month)) {
            throw new Error(`invalid month "${month}" (expected YYYY-MM)`);
          }

          if (action === "done" || action === "snooze" || action === "reopen") {
            const title =
              typeof args.title === "string" ? args.title.trim() : "";
            const scribe = this.createScribe(config, false);
            const outcome =
              action === "done"
                ? await scribe.completeReminder(title, { month })
                : action === "snooze"
                  ? await scribe.snoozeReminder(
                      title,
                      typeof args.until === "string" ? args.until : "",
                      { month },
                    )
                  : await scribe.reopenReminder(title, { month });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, action, ...outcome }, null, 2),
                },
              ],
            };
          }

          const all = args.all === true;
          const statusFilter =
            typeof args.status === "string" && args.status
              ? (args.status as ReminderStatus | "all")
              : undefined;
          const scribe = this.createScribe(config, true);
          let entries = all
            ? scribe.readAllReminders()
            : scribe.readReminders(month);
          if (statusFilter && statusFilter !== "all") {
            entries = entries.filter(
              (entry) => effectiveReminderStatus(entry) === statusFilter,
            );
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: true,
                    month: all ? null : month ?? currentMonth(),
                    entries,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "scribe_focus": {
          const all = args.all === true;
          const month =
            typeof args.month === "string" && args.month ? args.month : undefined;
          if (month && !isMonth(month)) {
            throw new Error(`invalid month "${month}" (expected YYYY-MM)`);
          }
          const scribe = this.createScribe(config, true);
          const items = all ? scribe.rankAll() : scribe.rank(month);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: true,
                    month: all ? null : month ?? currentMonth(),
                    items,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "scribe_search": {
          const month =
            typeof args.month === "string" && args.month ? args.month : undefined;
          if (month && !isMonth(month)) {
            throw new Error(`invalid month "${month}" (expected YYYY-MM)`);
          }
          const scribe = this.createScribe(config, true);
          const results = scribe.search({
            query: typeof args.query === "string" ? args.query : undefined,
            workspace:
              typeof args.workspace === "string" ? args.workspace : undefined,
            category:
              typeof args.category === "string"
                ? (args.category as KnowledgeEntry["category"])
                : undefined,
            status:
              typeof args.status === "string"
                ? (args.status as ReminderStatus | "all")
                : undefined,
            kind:
              typeof args.kind === "string"
                ? (args.kind as "all" | "knowledge" | "reminders")
                : undefined,
            month,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: true,
                    count: results.length,
                    results,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "scribe_context": {
          const scribe = this.createScribe(config, true);
          const pack = scribe.context({
            workspace:
              typeof args.workspace === "string" ? args.workspace : undefined,
            query: typeof args.query === "string" ? args.query : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, ...pack }, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool "${name}"`);
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      };
    }
  }

  private readResource(
    uri: string,
  ): Array<{ uri: string; mimeType: string; text: string }> {
    const config = this.resolveConfig();
    const scribe = this.createScribe(config, true);
    const month = currentMonth();

    switch (uri) {
      case "scribe://knowledge/current":
        return [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              { month, entries: scribe.readKnowledge(month) },
              null,
              2,
            ),
          },
        ];

      case "scribe://reminders/current":
        return [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              { month, entries: scribe.readReminders(month) },
              null,
              2,
            ),
          },
        ];

      case "scribe://focus/current":
        return [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              { month, items: scribe.rank(month) },
              null,
              2,
            ),
          },
        ];

      default:
        throw new Error(`Unknown resource URI: ${uri}`);
    }
  }
}

/**
 * Start the Scribe MCP server over stdio.
 * Supports both newline-delimited JSON-RPC 2.0 and Content-Length framed JSON-RPC 2.0.
 */
export async function runMcpServer(
  overrides: ConfigOverrides = {},
): Promise<number> {
  const server = new ScribeMcpServer(overrides);
  let buffer = Buffer.alloc(0);

  const writeResponse = (
    response: JsonRpcResponse,
    framed: boolean,
  ): void => {
    const payload = JSON.stringify(response);
    if (framed) {
      const byteLength = Buffer.byteLength(payload, "utf8");
      process.stdout.write(`Content-Length: ${byteLength}\r\n\r\n${payload}`);
    } else {
      process.stdout.write(`${payload}\n`);
    }
  };

  const dispatchLine = async (raw: string, framed: boolean): Promise<void> => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeResponse(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        framed,
      );
      return;
    }
    const response = await server.handleRequest(parsed);
    if (response) {
      writeResponse(response, framed);
    }
  };

  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length > 0) {
      const textPreview = buffer.toString("utf8");
      if (/^Content-Length:/i.test(textPreview)) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        const lfHeaderEnd = buffer.indexOf("\n\n");
        const sepIndex =
          headerEnd !== -1
            ? headerEnd
            : lfHeaderEnd !== -1
              ? lfHeaderEnd
              : -1;
        const sepLen = headerEnd !== -1 ? 4 : 2;
        if (sepIndex === -1) break;

        const headerText = buffer.subarray(0, sepIndex).toString("utf8");
        const match = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(sepIndex + sepLen);
          continue;
        }
        const contentLength = Number.parseInt(match[1], 10);
        const messageEnd = sepIndex + sepLen + contentLength;
        if (buffer.length < messageEnd) break;

        const body = buffer
          .subarray(sepIndex + sepLen, messageEnd)
          .toString("utf8");
        buffer = buffer.subarray(messageEnd);
        await dispatchLine(body, true);
        continue;
      }

      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = buffer.subarray(0, newlineIndex).toString("utf8");
      buffer = buffer.subarray(newlineIndex + 1);
      await dispatchLine(line, false);
    }
  }

  if (buffer.length > 0) {
    await dispatchLine(buffer.toString("utf8"), false);
  }

  return 0;
}
