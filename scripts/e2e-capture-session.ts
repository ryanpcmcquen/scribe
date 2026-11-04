import { Scribe } from "../src/scribe";
import { KnowledgeEntry } from "../src/storage";

async function main(): Promise<void> {
  const scribe = new Scribe({
    workspacePath: process.cwd(),
    repoPath: process.cwd(),
  });

  const entry: KnowledgeEntry = {
    date: "2026-11-04",
    title: "Scribe build session — phases 1-3",
    workspace: "~/notes/scribe",
    agent: "OpenCode",
    category: "work-log",
    body: "Built Scribe design into implementation: capture skills for OpenCode, Claude Code, Cline, Codex, Antigravity; storage/git scaffold; E2E capture/read/merge; README with logo; pushes. Design decisions: monthly split storage, always-automatic capture, configurable workspace, commit+push-if-remote.",
  };

  const path = await scribe.record(entry);
  console.log(`Scribe capture: recorded entry -> ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
