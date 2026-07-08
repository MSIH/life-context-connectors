# photo-exif

Two scripts that make a photo library time/place-queryable in [LifeContext](https://github.com/msih/life-context) with zero inference, then optionally enrich it with real content understanding. Implements [Milestone 4](https://github.com/msih/life-context/blob/2.0/docs/05-roadmap.md) of the roadmap — the **batch** reference connector, and the proof that upsert-as-enrichment works.

## Architecture decision: where the caption worker lives

The roadmap flags this as an open question ("worker lives with core or alongside — decide here," since doc 04 frames VLM captioning as a core-side "transducer," conceptually parallel to how core owns embeddings). **Decision: it lives here, in `photo-exif/`, as a second script alongside the scanner** — not in `life-context` core. Rationale:

- Consistency: `devsession-claude` and `imessage` are both pure isolated HTTP clients with zero direct database coupling; splitting `photo-exif`'s enrichment step into core would make it the only connector that isn't.
- The worker never needs to query "which artifacts need captions" from the server — it re-walks the same `PHOTO_ROOT` it already knows and checks its own local state file (`PHOTO_EXIF_CAPTION_STATE_PATH`). No new server-side capability required.
- It still upserts the *same artifact* (`source_id` = the relative file path, computed identically in both scripts via `lib/shared.js`), so the contract's upsert semantics do all the real work — the worker is just a slow, patient HTTP client like any other.

## What it does

### `scan.js` (deliverables 1–2)
1. Recursively walks `PHOTO_ROOT` for image files (`.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.tif`, `.tiff`).
2. Extracts `DateTimeOriginal` and GPS coordinates via `exifr`.
3. Reverse-geocodes GPS **fully offline** against a bundled dataset of ~115 major world cities (`lib/places.json`, haversine nearest-match) — no network call, nothing leaves the machine (doc 03's privacy tiering).
4. Computes a sha256 `content_hash` of the file bytes (streamed, not loaded fully into memory).
5. Sends `type='photo'` artifacts via `POST /api/v1/ingest/batch`.
6. Skips files unchanged since the last scan (mtime+size cache in `PHOTO_EXIF_MANIFEST_PATH`) — repeat scans over a large library only process what's new.

### `caption-worker.js` (deliverables 3–4)
1. Walks the same `PHOTO_ROOT`, skipping anything already captioned (local state file).
2. Sends each photo to a local vision-language model (Ollama, default `llava`) for a one-sentence caption.
3. Upserts the **same** `(source, source_id)` with the caption appended to the original EXIF-based description — the upsert's merge semantics (doc 04 §3) mean `occurred_at`/GPS/`place_label`/`raw_path`/`content_hash` are left untouched; only `text_repr` and `extra.captioned` change.
4. Saves its state after **every** photo, not batched — kill-safe at any point.
5. Stops the whole run (rather than failing through the entire library) if the VLM itself is unreachable; per-item ingest failures are logged and retried on the next run.
6. Does its own scheduling for **nothing** — one pass, then exits. Nightly-window scheduling is config, not code (see below).

## Setup

1. `cp .env.example .env` and fill in `LIFECONTEXT_URL` / `LIFECONTEXT_API_KEY` / `PHOTO_ROOT`.
2. `npm install` (real dependency: `exifr`).
3. Backfill: `node scan.js`.
4. Optionally, once you have a vision model pulled in Ollama (`ollama pull llava`): `node caption-worker.js`.

### Nightly-window scheduling (config, not code)

`caption-worker.js` does one pass and exits — schedule it to run during an off-hours window with cron (it naturally stops at the end of its pass; killing it mid-run is safe and just resumes next time):

```cron
# Run nightly between 1am and 5am; a `timeout` bounds the window in case the library is huge
0 1 * * * cd /path/to/life-context-connectors/photo-exif && timeout 4h node caption-worker.js >> ~/.life-context/photo-exif-captions.log 2>&1
```

On Windows, use Task Scheduler with a "Daily, 1:00 AM" trigger running `node caption-worker.js`, and a second trigger at 5:00 AM that kills the `node.exe` process if it's still running — see [`../../docs/windows-service-winsw.md`](https://github.com/msih/life-context/blob/2.0/docs/windows-service-winsw.md) in the core repo for the general Windows-service pattern this project uses.

## Exit test (roadmap M4)

"Photos from Austin in 2019" works from EXIF alone before any caption exists; a captioned photo answers a content query ("photos of us cooking") without creating a duplicate artifact — guaranteed by the ingest contract's upsert-on-`(source, source_id)` semantics, since `scan.js` and `caption-worker.js` compute `source_id` identically (`lib/shared.js`'s `sourceIdFor`).

## Known limitations

- **Reverse geocoding is coarse by design** — nearest *major* city from a ~115-entry bundled dataset, not a precise address. A rural photo may resolve to a city 100+ km away (prefixed "near"), or to nothing at all if the nearest dataset entry is beyond 300 km (`lib/reverse-geocode.js`'s `FAR_KM`). This is a deliberate zero-network, zero-third-party-dependency tradeoff, not a bug — a bigger dataset can be swapped into `lib/places.json` later without changing any calling code.
- **`occurred_at` is never guessed from file mtime.** A photo with no `DateTimeOriginal` gets no `occurred_at` (and the core server's own warning), never an approximation — an import-time mtime would make a 2019 photo sort as "today," which is worse than an honest gap (doc 04 §3).
- **Source ID is the relative file path.** Reorganizing the photo library after the first scan orphans history for moved files (a fresh `source_id` looks like a new artifact) — the same tradeoff every connector's `source`/`source_id` stability rule implies (doc 04 §3).
- **The caption worker has no real vision model to test against in this repo's CI/dev environment** — `test.mjs` verifies the full flow (state tracking, upsert-only-what-changed, VLM-down handling) against a mock Ollama server, but the actual caption quality/latency of a real `llava` (or similar) model is unverified here.

## Testing without a real photo library or VLM

`test.mjs` (`npm test`) synthesizes JPEGs with injected EXIF via `piexifjs` (analogous to how the `imessage` connector's tests use `bplist-creator`) and runs both scripts against mock ingest/VLM HTTP servers. Covers: EXIF+GPS, GPS-only, and no-metadata photos; unchanged-file skipping on re-scan; caption enrichment preserving EXIF-sourced fields via upsert semantics; kill-safe per-photo state; and VLM-unreachable handling.

## Files

- `scan.js` — the EXIF batch scanner
- `caption-worker.js` — the VLM enrichment worker
- `lib/shared.js` — env loading, directory walk, shared `source_id` computation, ingest client
- `lib/describe.js` — shared EXIF+place description logic (used by both scripts, so they can never drift)
- `lib/reverse-geocode.js` + `lib/places.json` — the offline reverse geocoder
- `test.mjs` — `node --test` suite
- `.env.example` — copy to `.env`
