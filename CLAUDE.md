# life-context-connectors — Agent Guide

<context>

## Prime Directive
Local-first, code-first. Every artifact optimized for machine consumption first, humans second.
When goals conflict: **correctness > simplicity > speed**.

## What This Is
The official connectors monorepo for [**LifeContext**](https://github.com/msih/life-context) — a local, self-owned AI memory server. Each top-level folder is one connector: an isolated process that gathers data from one corner of a digital life and submits it to a running LifeContext server over the versioned `POST /api/v1/ingest` contract. No connector imports LifeContext source or another connector's code — the HTTP contract is the only coupling point (see `docs/04-connector-contract.md`).

**Why a monorepo, not one repo per connector:** the contract's own distribution model (doc 04 §10) calls for independently forkable connectors, but with a single maintainer building the first few, splitting into N repos is pure overhead. One repo, one folder per connector, shared nothing between folders except convention. Split a connector out the moment it needs its own release cadence or an external owner — that's the trigger, not a timeline.

## Stack
- **Runtime:** Node.js 18+, ESM (`"type": "module"`) — no TypeScript, per connector folder.
- **Dependencies:** built-ins first (`fetch`, `node:fs/promises`, `node:crypto`). A connector adds a real dependency only when the source data genuinely needs one (e.g. `better-sqlite3` to read `chat.db`, `exifr` for EXIF) — declared in that connector's own `package.json`, never shared.
- **Wire format:** JSON over HTTP to a LifeContext server's `/api/v1/ingest` (or `/ingest/batch`), per `docs/04-connector-contract.md`. No connector calls Ollama or computes embeddings — that's core's job, not a connector's.

## Layout
```
README.md                  — repo overview, monorepo rationale, how to add a connector
docs/04-connector-contract.md — mirrored copy of the contract (source of truth: msih/life-context)
devsession/                — Claude Code SessionEnd hook -> dev_session artifacts (Milestone 1)
<connector>/                — one folder per additional connector, added the same way
.claude/rules/              — coding standards, connector conventions, design philosophy
```

## Run & Test
Each connector documents its own setup in its folder's `README.md` (env vars, how to register/trigger it, how to verify). There is no repo-wide build or server — this repo produces client processes, not a service. To verify a connector end-to-end without a live LifeContext server, point its `LIFECONTEXT_URL`/chat-model env vars at throwaway local HTTP servers that mimic the two responses it depends on (ingest 201/200 JSON, chat-completions JSON) — see `devsession/index.js`'s own development history for the pattern.

</context>

<rules>

## Absolute Rules
1. **All config via env — never hardcode** secrets, server URLs, or model names in a way that can't be overridden. Each connector ships a `.env.example` (placeholders) and gitignores its own `.env`.
2. **Never call Ollama or compute embeddings/vectors.** That is core's private business (`docs/04-connector-contract.md` §3) — it's what lets the embedding model change without touching a single connector. Connectors only produce `text_repr` (natural language) and metadata.
3. **`source_id` must be reproducible from the source data**, never a random UUID minted at runtime — random IDs defeat the ingest contract's upsert-by-`(source, source_id)` semantics (doc 04 §1.3, §3).
4. **Never buffer unbounded in memory on a connector failure.** If the LifeContext server is unreachable, spool to disk (append-only, flushed on the next run) rather than retry-loop in memory or drop the data — see `devsession/index.js`'s `spool`/`flushSpool` for the reference pattern.
5. **A connector must never hang or crash the process that invoked it.** Push-style connectors in particular (hooks, Shortcuts) run inside something else's flow — always exit cleanly (0) even on internal failure; log to stderr, never throw uncaught.
6. **Providers pluggable, config-driven** — a connector that itself talks to a local chat model (e.g. `devsession`'s summarizer) takes the endpoint/model from env, defaulting to local Ollama, never hardcoded.

## Every Change (mandatory workflow — no exceptions)
Enforced by gate hooks in `.claude/hooks/` (mirrored from `msih/life-context`, which documents the full rationale). This repo can be worked by multiple AI agents concurrently, so branches must be isolated in their own working dirs:
1. **`/draft-issue`** — file a GitHub issue and get explicit approval on the Implementation Plan first. (Gate denies `gh issue create` / `mcp__github__issue_write` without a fresh marker.)
2. **worktree** — create the branch with `git worktree add`, NEVER a plain `git checkout -b` / `git switch -c`.
3. **`/pre-pr-review`** — run this automatically/autonomously the moment implementation and its own verification are done, without waiting to be asked (or **`/pre-doc-review`** for doc-only changes). This clears the gate; it does **not** by itself open a PR — only do that once the user has actually asked for one. (Gate denies `gh pr create` without an APPROVE marker.)

`/planning` (Opus) can perform steps 1–2 (issue + plan + worktree) in one shot. The `worktree-edit-gate` hook **denies editing `.js`/`.mjs`/`.cjs` source outside a `.worktrees/` dir** — step 2 is not optional.

**Cloud/remote sessions (claude.ai/code, GitHub tasks): the workflow is enforced by the `cloud-issue-gate` hook.** These sessions have no `gh` CLI, so GitHub access goes through MCP tools instead — the gate blocks **every Edit/Write under the repo (including `.claude/` tooling and `CLAUDE.md`)** until an issue exists: draft the plan per `/draft-issue`, get explicit approval, file it via the GitHub MCP tool `issue_write`, then `echo <issue-number> > .claude/.cloud-issue-done` (gitignored; dies with the container, so each session re-earns it). The harness-assigned `claude/*` branch substitutes for the worktree; still run `/pre-pr-review` / `/pre-doc-review` before any PR, and the PR body still starts with `Closes #<n>`.
- For each connector touched, run its own verification (manual or scripted) before committing — there's no shared smoke test across connectors.
- Update the touched connector's own `README.md` when its behavior/setup changes; update the root `README.md` when the monorepo structure changes.
- Commit messages: imperative, ≤2 sentences. Reference issues/PRs as `#<n> "<title>"`.

## Style & Data
- Match the nearest existing connector's density and idiom (today: `devsession/index.js`). Details in `.claude/rules/coding-standards.md`.
- Wire-contract conventions (payload shape, `source`/`source_id` rules, spool/fallback pattern, entity hints): `.claude/rules/connector-conventions.md`.
- Design ethos (data preservation, logging, docs-close-to-code, baseline method, AI-artifact capture): `.claude/rules/design-philosophy.md`.

## Env / Config keys
There is no repo-wide `.env` — every connector folder has its own, documented in that folder's `README.md`. The two that recur across nearly every connector: `LIFECONTEXT_URL` (where LifeContext is running) and `LIFECONTEXT_API_KEY` (its `x-api-key` — set to the same value as `BRAIN_SECRET_KEY` in the core server's own `.env`).

## Workflow tooling & local settings
The mandatory-workflow tooling is committed in `.claude/` so it travels with the repo — cloud/remote agents get only the git checkout, never `~/.claude`. Mirrored from `msih/life-context` and adapted (no SQLite/embeddings concerns here; the "data model" persona became "connector conventions"):
- **Skills** (`.claude/commands/`): `/draft-issue`, `/pre-pr-review`, `/pre-doc-review`. **Agent** (`.claude/agents/`): `/planning` (Opus — issue + plan + worktree).
- **Hooks** (`.claude/hooks/`): `draft-issue-gate` + `pre-pr-review-gate` (deny), `worktree-gate` (advisory), `worktree-edit-gate` (deny `.js`/`.mjs`/`.cjs` edits outside a worktree; stands down in cloud sessions), `cloud-issue-gate` (deny ALL repo edits in cloud sessions until an issue number is in `.claude/.cloud-issue-done`), `session-start` (bootstrap Node deps per connector on cloud/remote). Wired + an `rm` deny in `.claude/settings.json`; direct-invocation tests in `hooks/test-gates.sh`.
Personal Claude Code settings (model, permission mode, extra hooks) go in **`.claude/settings.local.json`** (gitignored) — never commit those.

</rules>
