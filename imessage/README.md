# imessage

Reads `~/Library/Messages/chat.db` (read-only, WAL-safe) and syncs messages and photo attachments to [LifeContext](https://github.com/msih/life-context) as `message`/`photo` artifacts. Implements [Milestone 3](https://github.com/msih/life-context/blob/2.0/docs/05-roadmap.md) of the LifeContext roadmap — the **watch** reference connector, and the first one that proves deterministic entity links at volume.

## What it does

1. Opens `chat.db` read-only (`better-sqlite3`, `readonly: true`) and reads messages in ROWID order, past a locally-persisted cursor.
2. For each message: uses `text` if present, otherwise decodes the `attributedBody` binary-plist column (best-effort — see Known Limitations).
3. Emits a `type='message'` artifact with `entity_hints` (`sender`/`recipient`, phone or email, from the `handle` table) so LifeContext can link the conversation to a real contact.
4. Photo attachments (`image/*` MIME types only) are emitted as separate `type='photo'` artifacts with `raw_path` pointing at the file on disk.
5. Sends via `POST /api/v1/ingest/batch` (chunks of ≤100).
6. One script, two modes: a one-shot backfill (default — good for cron) or `--watch` (backfill once, then poll for new rows on an interval).

## Setup

1. `cp .env.example .env` and fill in `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY`.
2. `npm install` (this connector has real dependencies: `better-sqlite3` to read `chat.db`, `bplist-parser` to decode `attributedBody`).
3. **Grant Full Disk Access** to your terminal/Node (System Settings → Privacy & Security → Full Disk Access) — macOS protects `~/Library/Messages/chat.db` even for the owning user's other processes.
4. Backfill: `node index.js`. Watch mode (leave running, e.g. under `launchd`/`pm2`): `node index.js --watch`.
5. **Hub-and-spoke topology is just configuration**: to run this on a Mac Mini that syncs to a LifeContext server on another machine, set `LIFECONTEXT_URL` to that machine's LAN IP. No code change — that's the point of the ingest contract being plain HTTP.

## Exit test (roadmap M3)

"What did Sarah text me about the trip" returns real messages; `about_entity("Sarah")` shows message artifacts interleaved with notes; a full backfill re-run produces zero duplicates (guaranteed by the ingest contract's upsert-on-`(source, source_id)` semantics, independent of the local cursor file).

## Known limitations

- **`attributedBody` decoding is a reverse-engineered heuristic**, not a real NSKeyedArchiver parser (`bplist-text.js`) — Apple doesn't document this format. It walks every string in the archive and discards known class-name/attribute-key markers, keeping the longest survivor. This can misfire (return `null`, or occasionally the wrong string) on a future macOS release that changes NSKeyedArchiver's internals.
- **Only image attachments become artifacts.** Videos, documents, and other attachment types are not ingested yet — out of scope for this milestone, not silently dropped from consideration.
- **No self-identification hint.** The account owner's own phone/email isn't in `chat.db` (it's tied to the local Apple ID), so outgoing messages hint the *other* party's role as `recipient` but never emit a `self` hint for the account owner.
- **Group-chat participant fallback is a heuristic.** When an outgoing message has no direct `handle_id` (common in group chats on many macOS versions), every other participant in the chat is hinted as `recipient` — this can't distinguish "sent to the whole group" from "meant for one person" the way a human reading the thread could.
- **Failure posture**: a POST failure (network error, non-2xx) aborts the whole page and does **not** advance the cursor — the next run retries from the same point, since `chat.db` isn't going anywhere. A per-item validation failure inside an otherwise-successful batch response is logged but does not block the cursor (retrying a validation failure forever isn't productive).
- **Legacy date format**: `chat.db` on macOS 10.13+ stores `date` as nanoseconds since the Apple epoch (2001-01-01); older releases used seconds. Both are handled (`appleTimeToISO` in `index.js`), but only tested against the modern (nanosecond) format.

## Testing without a Mac

`test.mjs` (`npm test`) seeds a synthetic `chat.db` with the real iMessage schema (`message`, `handle`, `chat`, `chat_handle_join`, `chat_message_join`, `attachment`, `message_attachment_join`) — including a real `attributedBody` archive built with `bplist-creator` — and runs `index.js` against it with a mock ingest server. Covers: plain text, `attributedBody`-only text, a photo attachment, group-chat participant fallback, a tapback-shaped row being correctly skipped, cursor advancement, idempotent re-run, and the no-cursor-advance-on-failure behavior.

## Files

- `index.js` — the sync script
- `bplist-text.js` — the `attributedBody` decoder
- `test.mjs` — `node --test` suite against a synthetic `chat.db`
- `.env.example` — copy to `.env`
