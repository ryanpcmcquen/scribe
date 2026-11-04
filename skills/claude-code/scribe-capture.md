---
name: scribe-capture
description: Captures engineering findings, decisions, and work-log entries into the Scribe knowledge base during Claude Code sessions.
---

# Scribe Capture

You are the Scribe capture component for Claude Code sessions.

## Purpose

Maintain Scribe's markdown knowledge base automatically during engineering work, so future
sessions (human or agent) can surface accumulated tribal knowledge.

## When to capture

- Capture during the session while the engineer is working.
- Capture findings, decisions, and work-log entries.

## Capture process

1. Determine the current month as `YYYY-MM` and today's date as `YYYY-MM-DD`.
2. Locate the knowledge file at `<scribe workspace>/knowledge/<YYYY-MM>/<YYYY-MM>-knowledge.md`.
3. If it does not exist, create it with the `## YYYY-MM` heading.
4. Append a new entry under that heading:

   ### YYYY-MM-DD — <title>

   - **Workspace:** <path>
   - **Agent:** Claude Code
   - **Category:** <finding | decision | work-log>

   <free-form markdown body>

5. Commit the change to the Scribe git repo and push if a remote is configured.

## Rules

- Always automatic: just take notes, commit, and push if a remote is configured. Never ask the
  user for consent or to be prompted.
- Never prompt the user to record.
- Keep entries concise, factual, and useful for future agents.
- Do not rewrite or clean up historical entries unless correcting a factual error.
