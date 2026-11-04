# Scribe

![Scribe](scribe_logo.jpeg)

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

## Requirements

- Node.js 20 or newer
- git (for commit/push; Scribe can also run without a repo via `--no-git`)

## Install

From a checkout:

```bash
npm install
npm run build
npm link        # optional: puts `scribe` on your PATH
```

You can also run the built CLI directly:

```bash
node dist/cli.js --help
```

## Quick start

```bash
scribe init                       # create ~/notes/scribe-journal + config + git repo
scribe capture \
  --title "Storage is split by month" \
  --category decision \
  --repo "$PWD" \
  --body "Monthly files keep diffs small."
scribe read
scribe reminders
scribe focus
scribe doctor
```

`init` uses `~/notes/scribe-journal` by default. Point it somewhere else with
`--workspace` or the config file.

## CLI

```text
scribe <command> [options]

Commands:
  init       Initialize the journal, config, and optional git repo
  capture    Capture a knowledge entry or reminder
  read       Read knowledge entries
  reminders  Read reminders
  focus      Rank knowledge entries for a focus list
  doctor     Check config, workspace, git, and remote
  config     Show resolved configuration
  help       Show help
```

Global options:

| Option | Description |
| --- | --- |
| `--workspace <path>` | Journal/workspace path |
| `--config <path>` | Config file path |
| `--remote <name>` | Git remote name or URL |
| `--agent <name>` | Default agent label |
| `--json` | Emit machine-readable JSON |
| `--no-commit` | Do not commit after capture |
| `--no-push` | Do not push after capture |
| `--version` | Show version |

Read options: `--month <YYYY-MM>` or `--all`.

### Capture

Knowledge entry from flags:

```bash
scribe capture \
  --title "Use monthly files" \
  --category decision \
  --repo "$PWD" \
  --agent OpenCode \
  --body "Keeps diffs small."
```

Multi-line or scripted capture from JSON on stdin (flags override JSON fields):

```bash
scribe capture --stdin --agent OpenCode --repo "$PWD" <<'JSON'
{
  "title": "Use monthly files",
  "category": "decision",
  "body": "First paragraph.\n\nSecond paragraph."
}
JSON
```

Reminder (inferred when priority/context/action are present):

```bash
scribe capture \
  --title "Implement reminder lifecycle" \
  --priority p1 \
  --context "Only reading exists today." \
  --action "Add pending/done/snooze."
```

Capture options:

| Option | Description |
| --- | --- |
| `--type <knowledge\|reminder>` | Entry type (inferred when omitted) |
| `--title <title>` | Required entry title |
| `--date <YYYY-MM-DD>` | Entry date (defaults to local today) |
| `--repo <path>` | Workspace/repo the entry applies to |
| `--category <finding\|decision\|work-log>` | Knowledge category |
| `--body <markdown>` | Knowledge body or reminder action |
| `--priority <p1\|p2\|p3>` | Reminder priority |
| `--context <text>` | Reminder context |
| `--action <markdown>` | Reminder action |
| `--stdin` | Read a JSON entry from stdin |
| `--dry-run` | Validate without writing |

By default, capture writes the monthly file, commits to the journal repo, and
pushes when a remote is configured. Offline or remote-less journals still
commit locally; push is a no-op.

## Configuration

Default config path: `~/.config/scribe/config.json` (respects
`XDG_CONFIG_HOME`). Scribe creates it on `init`.

```json
{
  "workspace": "~/notes/scribe-journal",
  "remote": "origin",
  "agent": "OpenCode",
  "autoCommit": true,
  "autoPush": true
}
```

`remote` is optional. When omitted, Scribe uses `origin` if present, otherwise
the first configured remote. Repository paths are stored with `~/` rather than
an absolute home path.

Environment overrides (highest priority after command-line flags):

| Variable | Description |
| --- | --- |
| `SCRIBE_CONFIG` | Config file path |
| `SCRIBE_WORKSPACE` | Journal/workspace path |
| `SCRIBE_REMOTE` | Git remote name or URL |
| `SCRIBE_AGENT` | Default agent label |
| `SCRIBE_AUTO_COMMIT` | `true`/`false` |
| `SCRIBE_AUTO_PUSH` | `true`/`false` |

Precedence: command-line flags → environment → config file → defaults.

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
    cli.ts
    config.ts
    date.ts
    index.ts
    scribe.ts
    storage/
    git/
  test/
  scripts/
    e2e-capture-session.ts
    e2e-read.ts
    e2e-merge.ts
```

Scribe's live knowledge base does **not** live in this source repo. It lives in
the separate Scribe journal repo (default `~/notes/scribe-journal`); `EXAMPLE/`
shows the format only. The root `.gitignore` guards against accidentally
committing `knowledge/` or `reminders/` here.

## Development

```bash
npm run build      # compile TypeScript to dist/
npm run typecheck  # type-check without emitting
npm test           # build, then run the test suite
```

## Privacy

- Never commit absolute home-directory paths (for example, a path containing
  your username). Use `~/...` or `<workspace>` placeholders.
- The live knowledge base is kept out of this repo (`/knowledge/` and
  `/reminders/` are gitignored) and lives in the separate workspace repo.

## Status

CLI, config, storage, git commit/push, read/focus commands, and the capture
skills are implemented and tested. Capture skills invoke `scribe capture`
instead of hand-editing markdown. Next up: reminder lifecycle, search/context
retrieval, and capture reliability (hooks or MCP).
