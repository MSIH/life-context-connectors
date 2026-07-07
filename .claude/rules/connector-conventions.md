# Connector Conventions
globs: **/*.js — anything that talks to a LifeContext server's ingest API

This is the connector-side counterpart to `life-context`'s `.claude/rules/data-model.md`. Connectors never touch SQLite/sqlite-vec directly (doc 04 §1.1 — they're isolated HTTP clients, not in-process plugins), so the hazards here are about the wire contract, not the store. Full spec: `docs/04-connector-contract.md` (mirrored copy in this repo; source of truth is `msih/life-context`).

## The contract, in one paragraph
A connector's only job is to turn some corner of a digital life into `POST /api/v1/ingest` (or `/ingest/batch`) calls: `{source, source_id, type, text_repr, occurred_at?, content_hash?, latitude?, longitude?, place_label?, raw_path?, extra?, entity_hints?}`. Core does everything downstream — embedding, entity resolution, storage. A connector that tries to do core's job (compute a vector, assert an entity ID, delete data) has stepped outside the contract.

## Hard rules (the ones worth repeating)
1. **`source_id` must be reproducible from the source data** — a provider ID, a file path + mtime, a content hash — never a random UUID minted at call time. Ingestion is upsert-by-`(source, source_id)`; a random ID defeats that and creates a duplicate on every retry.
2. **Never call Ollama or compute embeddings.** `text_repr` is as far as a connector goes — core does the describing-to-vector step. This is what lets the embedding model change without touching a single connector.
3. **Entity hints, never entity IDs.** A connector that thinks it knows "this is my sister" still submits `{alias, alias_type, role, confidence?}` — resolution against the entity graph is core's job (doc 04 §4). A connector must never assert or invent an entity ID.
4. **`occurred_at` is when it happened, not when you ingested it.** Omit it (accept the warning) rather than guess — a wrong `occurred_at` is worse than a missing one, since it silently mis-sorts an artifact on the timeline.
5. **`content_hash`, when set, is a bare lowercase sha256 hex digest** (no algorithm prefix) — matches core's dedup comparison exactly; any other format silently breaks cross-import dedup instead of erroring.
6. **Nothing is ever cleared through the ingest API** — an explicit `null` on an optional field is rejected. If a connector needs to represent "this value is no longer known," that's a design question for core (doc 04 §11 open questions), not something to work around client-side.

## Failure posture (doc 04 §7)
- A connector that dies must lose at most its uncommitted window — never buffer unbounded in memory, never require the server to be up just to *observe* source data that isn't ephemeral (a message database sitting on disk doesn't need the server to be running to be read later).
- **Spool to disk, don't retry-loop in memory.** When the ingest call fails, append the payload (as JSON) to a local file and flush it on the connector's next run. See `devsession/index.js`'s `spool()`/`flushSpool()` for the reference implementation — including the caveat that a single shared spool file isn't safe under concurrent invocations of the same connector; per-payload files under a spool directory avoid that race if a connector might ever run concurrently with itself.
- **A push-style connector (a hook, a Shortcut) must never hang or crash the thing that invoked it.** Catch everything at the top level, log to stderr, and exit 0 regardless of internal outcome.

## Batch vs. single ingest
- Use `/api/v1/ingest/batch` for backlogs (up to 100 items/call, one failure isolated per item) — a one-shot backfill or cron scan.
- Use `/api/v1/ingest` for live trickle — a watch/push connector reacting to one event at a time.
- Respect `429`s with exponential backoff; the rate limit is per key.

## Cursor / incremental state
Incremental (watch/poll) connectors need a high-water mark. Keep it in a local file next to the connector (same directory discipline as the spool file), or use the optional `GET/PUT /api/v1/sources/:source/state` blob store once it ships — either is contract-conformant (doc 04 §7).
