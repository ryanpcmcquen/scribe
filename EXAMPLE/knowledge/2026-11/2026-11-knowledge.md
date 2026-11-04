## 2026-11

### 2026-11-03 — Split Scribe storage into per-month knowledge files

- **Workspace:** ~/notes/scribe
- **Agent:** opencode
- **Category:** decision

Moved from a single `KNOWLEDGE.md` with month headers to per-month files under
`knowledge/<YYYY-MM>/<YYYY-MM>-knowledge.md`. A bot reads exactly one file per
period; no header parsing; chronological order falls out of the filename; reads
stay small as the knowledge base accumulates.
