#!/usr/bin/env node
// Claude Code `SessionEnd` hook. Reads the hook JSON from stdin, reads the session transcript,
// asks a local chat model for a structured summary, and POSTs it to LifeContext as a
// `dev_session` artifact. See README.md for settings.json wiring.
//
// SessionEnd hooks cannot block session exit and the harness does not guarantee it waits for
// the process to finish (see docs/04-connector-contract.md §7 "Failure posture" for the
// contract-level rule this follows). This script is best-effort: it never throws past main(),
// and it always exits 0 so a slow/broken hook can never hang or fail the user's terminal.
import { readFile, appendFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadDotEnvIfPresent();

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
const CHAT_BASE_URL = process.env.CHAT_BASE_URL || 'http://localhost:11434/v1';
const CHAT_MODEL = process.env.CHAT_MODEL || 'qwen3:8b';
const SPOOL_PATH = process.env.DEVSESSION_SPOOL_PATH
  || path.join(os.homedir(), '.life-context', 'devsession-spool.jsonl');

const MAX_TRANSCRIPT_CHARS = 16000; // tail-truncate before handing to the chat model; recent turns matter most
const MIN_USER_TURNS = 1; // skip near-empty sessions (nothing worth remembering)

const SUMMARY_SYSTEM_PROMPT = [
  'Summarize this coding session in under 200 words of plain prose (no headers/bullets).',
  'Cover: what was done, key decisions and why, and any explicit next steps.',
].join(' ');

// Tiny manual .env loader (no dependency): KEY=VALUE lines, next to this script, never
// overrides a variable already set in the real environment.
function loadDotEnvIfPresent() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, rawValue = ''] = match;
    if (process.env[key] === undefined) process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Best-effort transcript parse. The JSONL entry shape is internal to Claude Code and can
// change between versions (undocumented — see the sessions doc), so every field access here
// is optional-chained and any line that doesn't match the expected shape is skipped rather
// than thrown on.
async function readTranscriptTurns(transcriptPath) {
  let raw;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry?.message?.role ?? entry?.type;
    const content = entry?.message?.content;
    if (!role || !content) continue;
    const text = Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      : typeof content === 'string' ? content : '';
    if (text.trim()) turns.push({ role, text: text.trim() });
  }
  return turns;
}

async function summarize(turns) {
  const transcriptText = turns.map((t) => `${t.role}: ${t.text}`).join('\n\n').slice(-MAX_TRANSCRIPT_CHARS);
  const res = await fetch(`${CHAT_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: transcriptText },
      ],
    }),
  });
  if (!res.ok) throw new Error(`chat model returned ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('chat model returned no content');
  return text;
}

// Used when the chat model is unreachable — still worth storing *something* rather than
// losing the session entirely (design-philosophy: never lose data over a soft dependency).
function fallbackSummary(turns) {
  const firstUser = turns.find((t) => t.role === 'user');
  const preview = firstUser ? firstUser.text.slice(0, 300) : '(no user message found)';
  return `Session ended (${turns.length} turns); local chat model was unavailable so no summary `
    + `was generated. First message: ${preview}`;
}

async function postIngest(payload) {
  const res = await fetch(`${LIFECONTEXT_URL}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LIFECONTEXT_API_KEY },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ingest returned ${res.status}`);
  return res.json();
}

async function spool(payload) {
  await mkdir(path.dirname(SPOOL_PATH), { recursive: true });
  await appendFile(SPOOL_PATH, `${JSON.stringify(payload)}\n`);
}

// Flush any payloads a prior, server-unreachable run couldn't deliver, before processing the
// current session — the connector contract's failure posture (doc 04 §7): lose at most the
// uncommitted window, never buffer unbounded, never require the server to be up to observe.
async function flushSpool() {
  let lines;
  try {
    lines = (await readFile(SPOOL_PATH, 'utf8')).split('\n').filter((l) => l.trim());
  } catch {
    return; // no spool file yet
  }
  const remaining = [];
  for (const line of lines) {
    try {
      await postIngest(JSON.parse(line));
    } catch {
      remaining.push(line);
    }
  }
  if (remaining.length) await writeFile(SPOOL_PATH, `${remaining.join('\n')}\n`);
  else await rm(SPOOL_PATH, { force: true });
}

async function main() {
  if (!LIFECONTEXT_API_KEY || LIFECONTEXT_API_KEY === 'change-this-to-a-long-secure-token') {
    console.error('devsession: LIFECONTEXT_API_KEY not configured (see .env.example); skipping');
    return;
  }

  const hookInput = JSON.parse(await readStdin());
  const { session_id: sessionId, transcript_path: transcriptPath, cwd } = hookInput;

  await flushSpool().catch((err) => console.error('devsession: spool flush failed', err));

  const turns = await readTranscriptTurns(transcriptPath);
  if (turns.filter((t) => t.role === 'user').length < MIN_USER_TURNS) return; // nothing to remember

  let summary;
  try {
    summary = await summarize(turns);
  } catch (err) {
    console.error('devsession: summarization failed, using fallback summary', err);
    summary = fallbackSummary(turns);
  }

  const payload = {
    source: 'devsession',
    source_id: sessionId,
    type: 'dev_session',
    text_repr: summary,
    occurred_at: new Date().toISOString(),
    extra: { project: path.basename(cwd ?? ''), cwd },
  };

  try {
    await postIngest(payload);
  } catch (err) {
    console.error('devsession: ingest failed, spooling for next run', err);
    await spool(payload);
  }
}

main()
  .catch((err) => console.error('devsession: unexpected error', err))
  .finally(() => process.exit(0)); // never hang or fail the user's terminal
