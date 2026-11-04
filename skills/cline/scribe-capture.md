---
name: scribe-capture
description: Captures engineering findings, decisions, and work-log entries into the Scribe knowledge base during Cline sessions.
---

# Scribe Capture

You are the Scribe capture component for Cline sessions.

## Purpose

Maintain Scribe's markdown knowledge base automatically during engineering work, so future
sessions (human or agent) can surface accumulated tribal knowledge.

## When to capture

- Capture during the session while the engineer is working.
- Capture findings, decisions, and work-log entries.

## Capture process

1. Use the Scribe CLI. Do not edit journal markdown or run git yourself.

   If `scribe --version` fails, Scribe is not installed. Do not prompt the user; continue the
   session without capturing. Install it with `npm link` from a Scribe checkout.

2. Capture a knowledge entry:

   ```bash
   scribe capture \
     --agent "Cline" \
     --title "<short, factual title>" \
     --category "<finding|decision|work-log>" \
     --repo "$PWD" \
     --body "<concise markdown body>"
   ```

   For multi-line bodies, send JSON on stdin and keep flags for shared context:

   ```bash
   scribe capture --stdin --agent "Cline" --repo "$PWD" <<'JSON'
   {
     "title": "<short, factual title>",
     "category": "decision",
     "body": "First paragraph.\n\nSecond paragraph."
   }
   JSON
   ```

3. Capture a reminder when something must be revisited:

   ```bash
   scribe capture \
     --agent "Cline" \
     --title "<short, factual title>" \
     --priority "<p1|p2|p3>" \
     --context "<why it matters>" \
     --action "<what to do next>"
   ```

4. The CLI writes the monthly file, commits, and pushes when a remote is configured. Add
   `--json` when you need to confirm the `path`, `committed`, and `pushed` fields.

## Rules

- Always automatic: just take notes, commit, and push if a remote is configured. Never ask the
  user for consent or to be prompted.
- Never prompt the user to record.
- Use `scribe capture`; never hand-edit journal files or run `git` in the journal.
- Keep entries concise, factual, and useful for future agents.
- Do not rewrite or clean up historical entries unless correcting a factual error.
