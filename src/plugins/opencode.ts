import { ConfigOverrides, loadConfig } from "../config";
import { runPostCommitHook } from "../hooks";
import { MCP_TOOLS, ScribeMcpServer } from "../mcp";

export interface OpenCodePluginContext {
  location?: {
    directory?: string;
  };
  options?: Record<string, unknown>;
  tool?: {
    transform(
      callback: (editor: {
        add(tool: {
          name: string;
          description: string;
          input: Record<string, unknown>;
          execute: (
            input: Record<string, unknown>,
          ) => Promise<{ content: string }>;
        }): void;
      }) => void,
    ): Promise<{ dispose(): Promise<void> }>;
  };
  session?: {
    hook(
      name: "context" | "compaction",
      callback: (event: {
        sessionID: string;
        system?: Array<{ type: string; text?: string }>;
        messages?: unknown[];
      }) => Promise<void> | void,
    ): Promise<{ dispose(): Promise<void> }>;
  };
}

export const SCRIBE_SYSTEM_DIRECTIVE = [
  "Scribe is active for this session.",
  "Automatically record important engineering findings (`finding`), architectural decisions (`decision`),",
  "and completed work milestones (`work-log`) using `scribe_capture` or `scribe capture` without prompting the user.",
].join(" ");

export function createOpenCodePlugin(overrides: ConfigOverrides = {}) {
  return {
    id: "scribe",
    async setup(ctx: OpenCodePluginContext): Promise<() => void> {
      const disposers: Array<() => Promise<void>> = [];
      const workspaceDir = ctx.location?.directory ?? process.cwd();
      const pluginOverrides: ConfigOverrides = {
        ...overrides,
        ...(typeof ctx.options?.workspace === "string"
          ? { workspace: ctx.options.workspace }
          : {}),
        ...(typeof ctx.options?.remote === "string"
          ? { remote: ctx.options.remote }
          : {}),
        agent:
          typeof ctx.options?.agent === "string"
            ? ctx.options.agent
            : overrides.agent ?? "OpenCode",
      };

      const mcp = new ScribeMcpServer(pluginOverrides);

      if (ctx.tool?.transform) {
        const reg = await ctx.tool.transform((editor) => {
          for (const toolDef of MCP_TOOLS) {
            editor.add({
              name: toolDef.name,
              description: toolDef.description,
              input: toolDef.inputSchema as unknown as Record<string, unknown>,
              execute: async (input) => {
                const mergedInput =
                  toolDef.name === "scribe_capture" && !input.workspace
                    ? { ...input, workspace: workspaceDir }
                    : input;
                const response = await mcp.handleRequest({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: {
                    name: toolDef.name,
                    arguments: mergedInput,
                  },
                });
                const result = response?.result as
                  | { content?: Array<{ text?: string }> }
                  | undefined;
                const text = result?.content?.[0]?.text ?? "{}";
                return { content: text };
              },
            });
          }
        });
        disposers.push(() => reg.dispose());
      }

      if (ctx.session?.hook) {
        const contextReg = await ctx.session.hook("context", (event) => {
          if (!Array.isArray(event.system)) return;
          const alreadyPresent = event.system.some(
            (part) =>
              typeof part.text === "string" &&
              part.text.includes("Scribe is active for this session."),
          );
          if (!alreadyPresent) {
            event.system.push({
              type: "text",
              text: SCRIBE_SYSTEM_DIRECTIVE,
            });
          }
        });
        disposers.push(() => contextReg.dispose());

        const compactionReg = await ctx.session.hook("compaction", async () => {
          try {
            const config = loadConfig(pluginOverrides);
            await runPostCommitHook(config, {
              repoPath: workspaceDir,
              agent: pluginOverrides.agent ?? "OpenCode",
            });
          } catch {
            // Best-effort automatic capture during compaction; never block compaction.
          }
        });
        disposers.push(() => compactionReg.dispose());
      }

      return () => {
        for (const dispose of disposers) {
          void dispose().catch(() => {});
        }
      };
    },
  };
}

export default createOpenCodePlugin();
