# devsession

A Claude Code `SessionEnd` hook that turns every coding session into a searchable `dev_session` artifact in [LifeContext](https://github.com/msih/life-context). Implements [Milestone 1](https://github.com/msih/life-context/issues/28) of the LifeContext roadmap — the **push** reference connector.

## What it does

1. Claude Code invokes `index.js` on `SessionEnd`, passing hook JSON (`session_id`, `transcript_path`, `cwd`, …) on stdin.
2. It reads the session transcript and asks a local chat model (Ollama/LM Studio, OpenAI-compatible) for a short summary — what was done, key decisions and why, next steps.
3. It `POST`s the summary to LifeContext as `POST /api/v1/ingest`, `type: 'dev_session'`, `source: 'devsession'`, `source_id` = the Claude Code session UUID.
4. If LifeContext is unreachable, the payload is appended to a local spool file instead of being dropped; the next session's hook run flushes anything spooled before processing itself.

## Setup

1. `cp .env.example .env` and fill in:
   - `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` — where LifeContext is running and its `x-api-key` (set the key to the same value as `BRAIN_SECRET_KEY` in the core server's own `.env`)
   - `CHAT_BASE_URL` / `CHAT_MODEL` — your local chat model endpoint (defaults assume Ollama with `qwen3:8b`; see `life-context`'s [`docs/local-llm-setup-guide.md`](https://github.com/msih/life-context/blob/2.0/docs/local-llm-setup-guide.md))
2. No `npm install` needed — zero dependencies, Node 18+ built-ins only (`fetch`, `fs/promises`).
3. Register the hook in your project's or user's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/life-context-connectors/devsession/index.js",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

No `matcher` — this fires for every `SessionEnd` reason (`clear`, `logout`, `prompt_input_exit`, …). Give it a generous `timeout`; a local chat-model call can take a while and there's nothing to gain by cutting it off early (see Known Limitations below).

4. End a real coding session, then the next morning try `search("where did I leave off")` over LifeContext's MCP or `POST /api/search` — it should return the session artifact with the right project context. That's the roadmap's exit test for this connector.

## Known limitations

- **`SessionEnd` cannot block session exit**, and Claude Code does not guarantee it waits for the hook process to finish. A slow local chat model may be killed mid-summary before it can either produce a summary or fall back — in that case the session is silently not recorded. There's no full fix within a single-process hook; a future iteration could split "capture" (fast, synchronous) from "summarize + send" (a detached background process) if this proves to be a real problem in practice.
- **The transcript JSONL format is internal to Claude Code and undocumented** (it can change between releases). `readTranscriptTurns()` in `index.js` is deliberately defensive — every field access is optional-chained and any line that doesn't match the expected shape is skipped rather than throwing — but a future Claude Code release could still change the shape enough that summaries degrade or come back empty. Sessions below `MIN_USER_TURNS` (currently 1) are skipped rather than logged as an empty artifact.
- Near-empty sessions (no user turns) are skipped entirely — nothing worth remembering, and it avoids polluting search with empty artifacts.

## Files

- `index.js` — the hook script (no dependencies)
- `.env.example` — copy to `.env`
- Spool file (not checked in): `~/.life-context/devsession-spool.jsonl` by default, override with `DEVSESSION_SPOOL_PATH`
