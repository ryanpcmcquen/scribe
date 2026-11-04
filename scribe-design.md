# Scribe — Design Document

> Status: design / planning. Reviewed against the current Flint codebase on 2026-11-02.

## Purpose

**Scribe** is a standalone tool (own repository, independent of Flint) that maintains a
markdown knowledge base for AI-assisted software work.

- Keeps a markdown record of important findings.
- Organizes what was worked on.
- Remembers things that agents can check later.
- Helps reduce context for agents by surfacing accumulated tribal knowledge useful for
  day-to-day decisions.
- Serves as a record of what was done and decisions made (and why).

Scribe is a *companion*: it should feel like a faithful, dependable companion that just
works, without asking the user anything or requiring manual recording.

## Design principles

1. **Standalone.** Scribe has no dependency on Flint. Flint may consume Scribe's output,
   but Scribe's capture/storage functionality must not be coupled to Flint.
2. **Automatic, prompt-driven capture.** Capture happens during sessions via agent-side
   skills/prompts. No user prompts or consent are required.
3. **Markdown-native storage.** Knowledge lives in a markdown repository that is
   version-controlled with git and optionally pushed to a remote.

## Capture

- Trigger: agent-side skills/prompts for the "top" CLI tools (Claude Code, Cline, OpenCode,
  Codex, Antigravity, etc.).
- Action: agents append findings / decisions / work-log entries into the knowledge base.
- Behavior: during sessions, always automatic — just take notes, commit to the repo, and
  push if it has a remote. No user prompts or consent.
- CLI scope: support the same CLI tools as Flint; capture skills now exist for Claude Code,
  Cline, OpenCode, Codex, and Antigravity under `skills/<cli>/scribe-capture.md`.

## Storage format

- Split by month into folders; applies to both knowledge and reminders.
- Folders & filenames include the month & year (e.g., `2026-11`).

Example layout:

    <scribe workspace>/
      knowledge/
        2026-11/
          2026-11-knowledge.md
      reminders/
        2026-11/
          2026-11-reminders.md

- Reminders: separate lifecycle (pending) from historical knowledge entries.

## Storage / git

- Scribe keeps a git repo in a workspace directory (sane default: `~/notes/scribe-knowledge` — Scribe's
  own folder under `~/notes`; configurable via options); the path is configurable. The knowledge
  base lives in its own git repo (workspace) — it does not live in Scribe's source repository,
  which holds Scribe's source/design only.
- Notes are committed automatically; pushed to the configured remote when one exists (no push
  when offline or unconfigured).

## Entry schema

Draft format for entries, now tightened into a concrete schema proposal:

### Knowledge — `knowledge/<YYYY-MM>/<YYYY-MM>-knowledge.md`

    ## YYYY-MM

    ### YYYY-MM-DD — <title>

    - **Workspace:** <path>
    - **Agent:** <capturing CLI>
    - **Category:** <finding | decision | work-log>

    <free-form markdown body>

### Reminders — `reminders/<YYYY-MM>/<YYYY-MM>-reminders.md`

    ## YYYY-MM

    ### YYYY-MM-DD — <title>

    - **Priority:** <p1 | p2 | p3>
    - **Context:** <why it is pending>

    <actionable pending item>

Reminders keep a distinct lifecycle (pending) from historical knowledge entries.

### Concrete schema proposal

Field sets per category — plain markdown lists rather than frontmatter, so entries stay
plain, greppable, and git-friendly:

**Knowledge entry**

- `title` — from the heading (`### YYYY-MM-DD — <title>`).
- `date` — implied by the heading + filename; no separate field needed.
- `workspace` — repo or path the insight applies to.
- `agent` — capturing CLI (claude | codex | cline | opencode | antigravity, etc.).
- `category` — `finding` | `decision` | `work-log`.
- Body — free-form markdown: context, decision, rationale, follow-ups.

**Reminders entry**

- `priority` — `p1` | `p2` | `p3`.
- `context` — why it is pending.
- Body — actionable pending item.

### Worked example

Knowledge (`knowledge/2026-11/2026-11-knowledge.md`):

    ## 2026-11

    ### 2026-11-03 — Split Scribe storage into per-month knowledge files

    - **Workspace:** ~/notes/scribe-knowledge
    - **Agent:** opencode
    - **Category:** decision

    Moved from a single KNOWLEDGE.md with month headers to per-month files under
    `knowledge/<YYYY-MM>/<YYYY-MM>-knowledge.md`. A bot reads exactly one file per period;
    no header parsing; chronological order falls out of the filename; reads stay small as
    the knowledge base accumulates.

Reminders (`reminders/2026-11/2026-11-reminders.md`):

    ## 2026-11

    ### 2026-11-03 — Configure Scribe git remote before first push

    - **Priority:** p2
    - **Context:** Auto-commit works; push needs a configured remote and auth.

    Add the remote to the Scribe workspace repo and verify push before relying on it.

## Read path / Flint's merge

Flint's morning brief / "Focus for today" synthesis merges multiple inputs:

1. Scribe knowledge entries (accumulated).
2. Flint-discovered sessions (recent work).
3. Git state (uncommitted changes / suggested focus).
4. MCP / messaging-derived priorities.

Flint produces a ranked focus list and overview from this merged input.

## Open design questions

- Whether Scribe's knowledge repo should be its own default or shared with Flint's journal
  via a configuration option (shareable if both installed, separate by default).
- Markdown entry schema details (fields per entry: date, workspace, findings, decisions, etc.).
- Precedence/weighting rules when merging Scribe entries into Flint's focus.

## Next steps

- Capture/skill generation: capture skills in place for Claude Code, Cline, OpenCode, Codex,
  and Antigravity.
- Implement Scribe storage + git push.
- Wire Flint's read/merge path.
