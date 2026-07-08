#!/usr/bin/env node
// Low-priority background worker: walks the same photo root as scan.js, captions any photo
// not yet captioned via a local vision-language model (Ollama's native /api/generate, not the
// OpenAI-compat endpoint — that's what supports the `images` field), and upserts the SAME
// (source, source_id) with an enriched text_repr. One photo at a time, state saved after each
// (kill-safe at any point per roadmap Milestone 4), throttled between calls.
//
// Nightly-window scheduling is config, not code (roadmap deliverable 4) — this script does a
// single pass and exits; start/stop it on a schedule with cron, launchd, or Task Scheduler.
// See README.md for a scheduling snippet.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent, walkImageFiles, sourceIdFor, ingestClient } from './lib/shared.js';
import { describePhoto, buildTextRepr } from './lib/describe.js';

loadDotEnvIfPresent(path.dirname(fileURLToPath(import.meta.url)));

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const PHOTO_ROOT = process.env.PHOTO_ROOT;
const VLM_BASE_URL = process.env.VLM_BASE_URL || 'http://localhost:11434';
const VLM_MODEL = process.env.VLM_MODEL || 'llava';
const VLM_PROMPT = process.env.VLM_PROMPT
  || "Describe this photo in one concise sentence, focused on what's happening and who or what is visible.";
// `|| 2000` would also override an explicit 0 (0 is falsy) — Number.isFinite distinguishes
// "not set" (NaN) from "set to zero" (a real, useful value for tests and manual runs).
const rawThrottle = Number(process.env.VLM_THROTTLE_MS);
const VLM_THROTTLE_MS = Number.isFinite(rawThrottle) ? rawThrottle : 2000;
const STATE_PATH = process.env.PHOTO_EXIF_CAPTION_STATE_PATH
  || path.join(os.homedir(), '.life-context', 'photo-exif-captions.json');

function readState() {
  try {
    return new Set(JSON.parse(readFileSync(STATE_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}

function writeState(captioned) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify([...captioned]));
}

async function caption(base64Image) {
  const res = await fetch(`${VLM_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VLM_MODEL,
      prompt: VLM_PROMPT,
      images: [base64Image],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`VLM returned ${res.status}`);
  const data = await res.json();
  const text = data?.response?.trim();
  if (!text) throw new Error('VLM returned no caption text');
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const { postIngest } = ingestClient({ url: LIFECONTEXT_URL, apiKey: LIFECONTEXT_API_KEY });
  const captioned = readState();
  let done = 0;
  let vlmDown = false;

  for await (const { absPath, relPath } of walkImageFiles(PHOTO_ROOT)) {
    if (captioned.has(relPath)) continue;
    if (vlmDown) break; // the VLM is unreachable; stop rather than fail through the whole library

    const { dateStr, place } = await describePhoto(absPath);

    let base64Image;
    try {
      base64Image = (await readFile(absPath)).toString('base64');
    } catch (err) {
      // A single unreadable/corrupt file must not be mistaken for the VLM being down —
      // skip it and keep going, same posture as scan.js.
      console.error(`photo-exif: skipping unreadable file ${relPath}`, err);
      continue;
    }

    let captionText;
    try {
      captionText = await caption(base64Image);
    } catch (err) {
      console.error(`photo-exif: VLM call failed for ${relPath}, stopping run (will resume next time)`, err);
      vlmDown = true;
      break;
    }

    const enrichedText = `${buildTextRepr(dateStr, place, path.basename(absPath))} ${captionText}`;
    try {
      // Present fields only: text_repr + extra. Per doc 04 §3 upsert merge semantics, everything
      // scan.js already stored (occurred_at, GPS, place_label, raw_path, content_hash) is left
      // untouched — this is exactly the "enrichment wave" the contract's upsert exists for.
      await postIngest({
        source: 'photo-exif',
        source_id: sourceIdFor(relPath),
        type: 'photo',
        text_repr: enrichedText,
        extra: { captioned: true },
      });
      captioned.add(relPath);
      writeState(captioned); // after every success, not batched — kill-safe at any point
      done++;
    } catch (err) {
      console.error(`photo-exif: ingest failed for ${relPath}, will retry next run`, err);
    }

    await sleep(VLM_THROTTLE_MS);
  }

  console.error(`photo-exif: captioned ${done} photo(s) this run`);
}

main()
  .then(() => process.exit(0)) // fetch's keep-alive sockets would otherwise hold the process open
  .catch((err) => {
    console.error('photo-exif: caption worker failed', err);
    process.exit(1);
  });
