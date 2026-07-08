# Coding Standards
globs: **/*.js, **/*.mjs

## Code-First Principle
Generated code is optimized for machine consumption: concise, dense, pattern-matched to the existing codebase (`devsession-claude/index.js`, `imessage/index.js`, `photo-exif/scan.js` are the current density/idiom references).

## Before Creating/Editing Any File
1. Read the nearest existing connector of the same kind (or `devsession-claude/index.js` if none) first.
2. Match its structure, density, and style exactly.
3. Do not introduce new patterns, frameworks, or formatting conventions unasked.

## Module & Language
- **ESM only** — `import`/`export`, `"type": "module"`. No `require`, no CommonJS.
- Node 18+ built-ins are fine (`node:crypto`, `fetch`, `node:fs/promises`). Prefer built-ins over new deps — a connector adds a real dependency only when the source data genuinely needs one.
- `async`/`await` for all async work. No floating promises — `await` them or explicitly `void`/handle.
- No TypeScript; but keep shapes obvious.

## Naming
| Element | Convention | Example |
|---------|------------|---------|
| Variables / functions | `camelCase` | `readTranscriptTurns`, `postIngest` |
| Classes / constructors | `PascalCase` | (none yet — plain functions so far) |
| Constants (module-level config) | `UPPER_SNAKE` | `LIFECONTEXT_URL`, `MAX_TRANSCRIPT_CHARS` |
| Async functions | verb-first | `summarize`, `flushSpool` |

## Required
- All config through `process.env`; never hardcode secrets, keys, URLs, or model names.
- Structured errors: on catch, log the error object (`console.error("context", err)`), never swallow. A push-style connector (a hook) must still exit 0 after logging — never crash the process that invoked it.
- No connector calls Ollama or computes embeddings/vectors — that's core's job (`docs/04-connector-contract.md` §3).

## Prohibited
- Hardcoded secrets / API keys / tokens — why: this repo is public; secrets live in each connector's `.env` (gitignored).
- Committing `.env`, `node_modules/`, or any local spool/cursor state file — why: secrets, machine-specific, and disposable.
- Empty `catch {}` — why: hides failures; always log or rethrow.
- Magic numbers (timeouts, size caps, retry counts) — name them as constants — why: self-documenting and single-source.
- `var`; `require()`; blocking sync I/O in a hot path (a one-shot startup read like an `.env` loader is fine).
- Commented-out code — why: noise; git history is the archive.

## No copyright header
No mandatory copyright header — MIT + public. Don't add one.
