#!/usr/bin/env node
// Batch-scans a photo archive: EXIF DateTimeOriginal + GPS, offline reverse-geocode, sha256
// content_hash, minimal text_repr — POSTed to LifeContext via /api/v1/ingest/batch. Zero
// inference beyond what EXIF + a local city dataset already know (doc 04's transducer split:
// this connector describes, core embeds). See README.md for setup and the exit test.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent, walkImageFiles, sourceIdFor, contentHashOfFile, chunk, ingestClient } from './lib/shared.js';
import { describePhoto, buildTextRepr } from './lib/describe.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const PHOTO_ROOT = process.env.PHOTO_ROOT;
const MANIFEST_PATH = process.env.PHOTO_EXIF_MANIFEST_PATH
  || path.join(os.homedir(), '.life-context', 'photo-exif-manifest.json');
const BATCH_MAX = 100; // contract cap (docs/04-connector-contract.md §2)

function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeManifest(manifest) {
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));
}

async function buildPayload(absPath, relPath) {
  const { date, dateStr, place, latitude, longitude } = await describePhoto(absPath);
  const contentHash = await contentHashOfFile(absPath);

  const payload = {
    source: 'photo-exif',
    source_id: sourceIdFor(relPath),
    type: 'photo',
    text_repr: buildTextRepr(dateStr, place, path.basename(absPath)),
    content_hash: contentHash,
    raw_path: absPath,
    extra: { captioned: false },
  };
  // occurred_at is when the photo was TAKEN, never a mtime/import-time guess — doc 04 §3 is
  // explicit that a 2019 photo imported today must still sort into 2019, so an unknown date
  // is omitted (and warned on) rather than approximated with something that's actively wrong.
  if (date) payload.occurred_at = date.toISOString();
  if (latitude != null) {
    payload.latitude = latitude;
    payload.longitude = longitude;
  }
  if (place) payload.place_label = place;
  return payload;
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('photo-exif: LIFECONTEXT_API_KEY not configured (see .env.example)');
    process.exit(1);
  }
  if (!PHOTO_ROOT || !existsSync(PHOTO_ROOT)) {
    console.error(`photo-exif: PHOTO_ROOT not set or doesn't exist: ${PHOTO_ROOT}`);
    process.exit(1);
  }

  const { postIngestBatch } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const manifest = readManifest();
  let scanned = 0;
  let skippedUnchanged = 0;
  const pending = [];

  const flush = async () => {
    if (!pending.length) return;
    for (const group of chunk(pending, BATCH_MAX)) {
      const result = await postIngestBatch(group.map((p) => p.payload));
      result.results.forEach((r, i) => {
        if (r.error) {
          console.error('photo-exif: item failed', group[i].payload.source_id, r.error, r.issues ?? '');
        } else {
          // Only cache success — a failed item must be retried on the next scan, not skipped
          // as "unchanged" forever.
          manifest[group[i].relPath] = group[i].statKey;
        }
      });
    }
    pending.length = 0;
  };

  for await (const { absPath, relPath } of walkImageFiles(PHOTO_ROOT)) {
    // statSync AND buildPayload share one try/catch — a permission error or broken file entry
    // can throw from either, and either way it must skip just this file, not abort the scan.
    let statKey;
    let payload;
    try {
      const stat = statSync(absPath);
      statKey = `${stat.mtimeMs}:${stat.size}`;
      if (manifest[relPath] === statKey) {
        skippedUnchanged++;
        continue;
      }
      payload = await buildPayload(absPath, relPath);
    } catch (err) {
      console.error(`photo-exif: skipping unreadable file ${relPath}`, err);
      continue;
    }
    scanned++;
    pending.push({ relPath, statKey, payload });
    if (pending.length >= BATCH_MAX) await flush();
  }
  await flush();
  writeManifest(manifest);

  console.error(`photo-exif: scanned ${scanned} new/changed file(s), skipped ${skippedUnchanged} unchanged`);
}

main()
  .then(() => process.exit(0)) // fetch's keep-alive sockets would otherwise hold the process open
  .catch((err) => {
    console.error('photo-exif: scan failed', err);
    process.exit(1);
  });
