<p align="center">
  <img src="scribe_logo.jpeg" alt="Scribe" width="420">
</p>

# Scribe

**Scribe** is a standalone tool that maintains a markdown knowledge base for AI-assisted software work.

- Keeps a markdown record of important findings.
- Organizes what was worked on.
- Remembers things that agents can check later.
- Helps reduce context for agents by surfacing accumulated tribal knowledge useful for day-to-day decisions.
- Serves as a record of what was done and decisions made (and why).

Scribe is a *companion*: it should feel like a faithful, dependable companion that just works, without asking the user anything or requiring manual recording.

## How it works

- **Capture:** automatic, prompt-driven via agent-side skills for top CLI tools (Claude Code, Cline, OpenCode, Codex, Antigravity). During sessions, always automatic — just take notes, commit, push if a remote is configured.
- **Storage:** markdown-native, split by month into folders; filenames include month & year (e.g., `2026-11/2026-11-knowledge.md`).
- **Read:** Scribe exposes accumulated knowledge entries for Flint's morning-brief / "Focus for today" merge.

## Layout

```text
scribe/
  EXAMPLE/
    knowledge/2026-11/2026-11-knowledge.md
    reminders/2026-11/2026-11-reminders.md
  scribe-design.md
  scribe_logo.jpeg
  skills/
    opencode/scribe-capture.md
    claude-code/scribe-capture.md
    cline/scribe-capture.md
    codex/scribe-capture.md
    antigravity/scribe-capture.md
  src/
    index.ts
    scribe.ts
    storage/
    git/
  scripts/
    e2e-capture-session.ts
    e2e-read.ts
    e2e-merge.ts
```

Scribe's live knowledge base does **not** live in this source repo. It lives in
a separate workspace repo (default `~/notes/scribe`); `EXAMPLE/` shows the
format only. The root `.gitignore` guards against accidentally committing
`knowledge/` or `reminders/` here.

## Privacy

- Never commit absolute home-directory paths (for example, a path containing
  your username). Use `~/...` or `<workspace>` placeholders.
- The live knowledge base is kept out of this repo (`/knowledge/` and
  `/reminders/` are gitignored) and lives in the separate workspace repo.

## Status

Design / planning. Capture skills drafted, storage + git + orchestrator scaffolded, and end-to-end capture/read runs verified.
