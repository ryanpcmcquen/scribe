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
# optional: puts `scribe` on your PATH
npm link
```

The package artifact includes the five agent skill templates. `npm test`
creates a package archive and verifies that the packaged CLI and
`scribe hooks install --skills --all-agents` work from that archive.

You can also run the built CLI directly:

```bash
node dist/cli.js --help
```

## Quick start

```bash
# create ~/notes/scribe-journal + config + git repo
scribe init
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
  import     Import Markdown, JSON, text, HTML, Git history, or web pages
  read       Read knowledge entries
  reminders  Read or update reminders (done, snooze, reopen)
  focus      Rank knowledge entries and pending reminders for a focus list
  search     Search across months over knowledge entries and reminders
  context    Build a compact context pack for a workspace or query
  stats      Show summary statistics across knowledge entries and reminders
  verify     Audit journal structure and scan for likely secrets
  catalog    Build or search the local AI retrieval catalog
  sync       Sync journal repo (commit local changes, pull --rebase, push)
  mcp        Start the Model Context Protocol (MCP) server on stdio
  hook       Run an automatic capture hook (post-commit, agent-stop)
  hooks      Install, uninstall, or check git hooks and agent skills
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

Manage reminder lifecycle (`done`, `snooze`, `reopen`) and filter by status:

```bash
scribe reminders --pending
scribe reminders snooze "Implement reminder lifecycle" --until 2026-11-10
scribe reminders reopen "Implement reminder lifecycle"
scribe reminders done "Implement reminder lifecycle"
```

Active pending reminders (including snoozed reminders whose snooze date has
arrived) enter `scribe focus` ranked by priority (`p1` → score `4`, `p2` → `3`,
`p3` → `2`), while `done` and future-`snoozed` reminders are excluded.

### Import Knowledge Locally

`scribe import` adapts local Markdown/Obsidian, JSON, JSONL, plain text, HTML,
Git history, and HTTP(S) pages into Scribe knowledge entries. It parses and
normalizes locally without model/API calls, preserves source references, and
stores source IDs so repeat imports of unchanged content are skipped. A batch
is committed and pushed once, not once per imported item.

```bash
scribe import ~/notes/old-knowledge --dry-run
scribe import ~/notes/old-knowledge --json
scribe import ~/exports/confluence.json
scribe import ~/code/legacy-project --format git --since 2026-01-01 --limit 100
scribe import https://docs.example.org/guide --dry-run
```

Markdown frontmatter fields `title`, `date`, `workspace`, `agent`, `category`,
`tags`, and `summary` are used when present. JSON records accept common fields
such as `title`, `date`, `body`, `content`, `workspace`, `category`, and `tags`;
Confluence REST JSON page responses are supported.

URL import accepts HTML, JSON, and text responses, follows a limited number of
redirects, and enforces response size limits. Private-network destinations are
blocked by default; use `--allow-private-network` only for a trusted internal
URL. Custom request headers can be supplied through `SCRIBE_IMPORT_HEADERS` as
a JSON object. Keep credentials in a secret manager or environment, never in
Scribe config or command-line arguments.

### Local AI Catalog

`scribe catalog build` creates a local, rebuildable metadata cache outside the
journal. It derives short extractive summaries and automatic keyword tags from
Markdown without AI calls. The first build scans the journal; later builds
reuse unchanged monthly files, and successful captures refresh the changed
month when a catalog already exists.

```bash
scribe catalog build
scribe catalog build --force
scribe catalog search "concurrent journal sync" --limit 5
```

Catalog search returns compact summaries, tags, and source paths, not full note
bodies. Results use local BM25-style ranking, so title matches and rare terms
matter more than raw repetition. Markdown remains canonical and the cache can be
regenerated at any time.

### Journal README Index

Scribe creates and updates a managed table of contents in the journal's
`README.md` during `scribe init`, captures, imports, reminder updates, and
`scribe sync`. It links monthly knowledge and reminder files with relative paths
and preserves README content outside the managed section.

### Search & Context Retrieval

Search across all months over both knowledge entries and reminders:

```bash
scribe search "WAL concurrency"
scribe search --repo "$PWD" --category decision --json
```

Retrieve a compact, high-signal context pack (pending reminders, key decisions,
findings, and recent work) for an agent or human, or view summary statistics:

```bash
scribe context --repo "$PWD"
scribe context --repo "$PWD" --query "storage layout" --json
scribe stats --all
scribe stats --month 2026-11 --repo "$PWD" --json
```

### Multi-Source Focus & Flint Merge

Compose Scribe's ranked knowledge and pending reminders with external git,
session, and MCP inputs, or emit `- <workspace>: <title>` bullets directly for
Flint's morning brief. Knowledge entries apply gentle recency decay relative to
`--date <YYYY-MM-DD>` (defaulting to today) so fresh findings surface above
stale entries, while active reminders hold their priority score until completed
or snoozed:

```bash
scribe focus --bullets --limit 5
scribe focus --stdin --limit 5 --json <<'JSON'
{
  "git": [{ "title": "Finish uncommitted changes", "workspace": "~/code/flint", "uncommitted": true }],
  "mcp": [{ "title": "Reply to release thread", "workspace": "slack", "priority": "p1" }],
  "sessions": [{ "title": "Pick up: Scribe build", "workspace": "~/code/scribe" }]
}
JSON
```

### Multi-Machine Git Sync & Rebase Resilience

When pushing after `scribe capture` or `scribe reminders`, Scribe automatically
retries a rejected non-fast-forward push by running
`git pull --rebase --autostash` and pushing again (`rebased: true`), aborting
cleanly if a conflict occurs. You can also synchronize the journal explicitly at
any time:

```bash
scribe sync --json
```

The process lock coordinates Scribe processes on the same machine. For separate
machines, Git's pull/rebase-and-push flow handles non-fast-forward updates;
conflicts are reported rather than silently resolved.

### Verify Existing Journal Data

`scribe verify` is a read-only audit of monthly knowledge and reminder
markdown. It checks entry headings, dates, required fields, categories,
priorities, reminder status fields, and expected storage paths. It also scans
for likely secrets without including the detected values in its output:

```bash
scribe verify
scribe verify --json
scribe verify --history
```

`--history` also scans journal markdown in commits reachable from local Git
refs; fetch remotes first to include their current branches. The command exits
with status `1` if it finds an issue. Verification is read-only and never
rewrites files or history. If a real credential was committed, rotate it and
remove it from history separately.

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
commit locally; push is a no-op. Identical entries recorded on the same day are
deduplicated automatically (`deduplicated: true`). A per-journal process lock
serializes capture, reminder updates, and sync operations on the same machine.
Home-directory paths are scrubbed to `~`. Common GitHub/GitLab, OpenAI/Stripe,
AWS, Google, npm/PyPI, and Slack tokens, JWTs, bearer values, credential
assignments, URL passwords, and PEM private-key blocks are redacted before
writing. Optional `redactionLiterals` in config add exact, case-sensitive
strings to scrub; they are applied to new captures and verification without
being printed by `scribe config`. Detection is heuristic, not a guarantee that
every secret is caught; avoid sending credentials to Scribe and review captures
before sharing the journal.

## Capture reliability (MCP, hooks, and OpenCode plugin)

Skills alone can miss captures when an agent forgets to load the skill or
finishes a commit/session without invoking `scribe capture`. Scribe layers three
automatic mechanisms on top of the skills:

1. **Built-in stdio MCP server (`scribe mcp`)** — exposes `scribe_capture`,
   `scribe_read`, `scribe_reminders`, `scribe_focus`, `scribe_search`, and
   `scribe_context` tools plus `scribe://knowledge/current`,
   `scribe://reminders/current`, and `scribe://focus/current` resources over
   JSON-RPC 2.0 stdio (supporting both newline-delimited and `Content-Length`
   framing).
2. **Automatic git & agent hooks (`scribe hook` / `scribe hooks`)**:
   - `scribe hooks install --git --repo <path>` installs a managed,
     non-destructive `post-commit` hook that records commits into Scribe
     (skipping the Scribe journal repo itself and deduplicating already-recorded
     commits).
   - `scribe hooks install|status|uninstall --scan ~/code` bulk-manages
     `post-commit` hooks across every git repository under a directory while
     automatically skipping the Scribe journal workspace.
   - `scribe hook agent-stop --stdin` accepts agent stop-hook JSON payloads (or
     falls back to capturing today's latest commit in the workspace).
   - `scribe hooks install --skills` syncs the OpenCode capture skill into
      `~/.config/opencode/skills/scribe-capture/SKILL.md`; add `--all-agents` to
      sync skill templates for OpenCode, Claude Code, Codex, Cline, and
      Antigravity at once.
   - `scribe hooks status --skills --all-agents` checks the five global skill
      destinations without printing skill contents.
   - Global locations: OpenCode `~/.config/opencode/skills/`, Claude Code
      `~/.claude/skills/`, Codex `~/.agents/skills/`, Cline `~/.cline/skills/`,
      and Antigravity `~/.gemini/config/skills/`.
3. **OpenCode V2 server plugin (`dist/plugins/opencode.js`)** — registers the
    six Scribe tools natively, injects the Scribe capture directive into
    session context hooks so the model never forgets to record findings and
    decisions, and captures unrecorded commits on session compaction.

## Configuration

Default config path: `~/.config/scribe/config.json` (respects
`XDG_CONFIG_HOME`). Scribe creates it on `init`.

```json
{
  "workspace": "~/notes/scribe-journal",
  "remote": "origin",
  "agent": "OpenCode",
  "autoCommit": true,
  "autoPush": true,
  "redactionLiterals": ["ORG_PRIVATE_PREFIX_"]
}
```

`remote` is optional. When omitted, Scribe uses `origin` if present, otherwise
the first configured remote. Repository paths are stored with `~/` rather than
an absolute home path. `redactionLiterals` is an optional array of exact,
case-sensitive strings (up to 100 values, 256 characters each). Values are
stored in your local Scribe config and are not shown by `scribe config`.

Environment overrides (highest priority after command-line flags):

| Variable | Description |
| --- | --- |
| `SCRIBE_CONFIG` | Config file path |
| `SCRIBE_WORKSPACE` | Journal/workspace path |
| `SCRIBE_REMOTE` | Git remote name or URL |
| `SCRIBE_AGENT` | Default agent label |
| `SCRIBE_AUTO_COMMIT` | `true`/`false` |
| `SCRIBE_AUTO_PUSH` | `true`/`false` |
| `SCRIBE_REDACTION_LITERALS` | JSON array of exact strings |
| `SCRIBE_IMPORT_HEADERS` | JSON object of HTTP headers for URL imports |

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
    catalog/
    config.ts
    date.ts
    import/
    index.ts
    journal-index.ts
    lock.ts
    scribe.ts
    hooks/
    verify/
    stats/
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
# compile TypeScript to dist/
npm run build
# type-check without emitting
npm run typecheck
# build, then run the test suite
npm test
```

## Privacy

- Never commit absolute home-directory paths (for example, a path containing
  your username). Use `~/...` or `<workspace>` placeholders.
- The live knowledge base is kept out of this repo (`/knowledge/` and
  `/reminders/` are gitignored) and lives in the separate workspace repo.

## Status

CLI, config, storage, git sync/rebase, reminder lifecycle (`done`/`snooze`/`reopen`),
multi-format import, a local automatic-summary/keyword catalog, cross-month
search/context, stats, recency-weighted focus, all-agent skill and multi-repo
hook installers, MCP/hooks/OpenCode plugin capture reliability, deduplication,
and heuristic secret/home-path redaction are implemented and tested.
`scribe verify` audits current files and reachable Git history. CI covers typechecking,
the test suite, and privacy checks; the package artifact is smoke-tested to
ensure skill templates ship with the CLI. Captures and syncs maintain the Scribe
journal README's monthly index while preserving content outside its managed section.
