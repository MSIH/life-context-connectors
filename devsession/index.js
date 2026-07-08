#!/usr/bin/env node
// Claude Code `SessionEnd` hook. Reads the hook JSON from stdin, reads the session transcript,
// asks a chat model (by default, the already-authenticated Claude Code CLI itself) for a
// structured summary, and POSTs it to LifeContext as a `dev_session` artifact. See README.md
// for settings.json wiring.
//
// SessionEnd hooks cannot block session exit and the harness does not guarantee it waits for
// the process to finish (see docs/04-connector-contract.md §7 "Failure posture" for the
// contract-level rule this follows). This script is best-effort: it never throws past main(),
// and it always exits 0 so a slow/broken hook can never hang or fail the user's terminal.
import { readFile, appendFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadDotEnvIfPresent();

const LIFECONTEXT_URL = process.env.LIFECONTEXT_URL || 'http://localhost:3000';
const LIFECONTEXT_API_KEY = process.env.LIFECONTEXT_API_KEY;
// 'claude-cli' (default) shells out to the Claude Code binary already authenticated in this
// environment — no local LLM or API key to manage. 'openai' keeps the original OpenAI-compatible
// HTTP path (Ollama/LM Studio/hosted) for anyone who prefers it.
const CHAT_PROVIDER = process.env.CHAT_PROVIDER || 'claude-cli';
const CHAT_BASE_URL = process.env.CHAT_BASE_URL || 'http://localhost:11434/v1';
const CHAT_MODEL = process.env.CHAT_MODEL || (CHAT_PROVIDER === 'claude-cli' ? 'haiku' : 'qwen3:8b');
const CHAT_API_KEY = process.env.CHAT_API_KEY; // openai provider only; omit for an unauthenticated local endpoint
const SPOOL_PATH = process.env.DEVSESSION_SPOOL_PATH
  || path.join(os.homedir(), '.life-context', 'devsession-spool.jsonl');

const MAX_TRANSCRIPT_CHARS = 16000; // tail-truncate before handing to the chat model; recent turns matter most
const MIN_USER_TURNS = 1; // skip near-empty sessions (nothing worth remembering)
const SUMMARIZE_TIMEOUT_MS = 90_000; // stay inside the hook's typical 120s settings.json timeout

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
  return CHAT_PROVIDER === 'claude-cli' ? summarizeViaClaudeCli(turns) : summarizeViaOpenAi(turns);
}

// Default provider: shells out to the Claude Code CLI already authenticated in this environment
// (subscription OAuth or ANTHROPIC_API_KEY) — no local LLM, no separate key to manage, works the
// same on a laptop or a Claude Code web container. --safe-mode disables hooks/CLAUDE.md/etc. in
// the child so it can never re-trigger this SessionEnd hook; DEVSESSION_DISABLE is a second,
// belt-and-suspenders guard checked at the top of main(). --no-session-persistence keeps the
// summarizer's own session out of /resume and off disk. --tools "" means pure text in, text out.
function summarizeViaClaudeCli(turns) {
  const transcriptText = turns.map((t) => `${t.role}: ${t.text}`).join('\n\n').slice(-MAX_TRANSCRIPT_CHARS);
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', '--safe-mode', '--no-session-persistence', '--tools', '', '--model', CHAT_MODEL,
        '--system-prompt', SUMMARY_SYSTEM_PROMPT],
      { timeout: SUMMARIZE_TIMEOUT_MS, env: { ...process.env, DEVSESSION_DISABLE: '1' } },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`claude -p failed: ${err.message}${stderr.trim() ? ` (${stderr.trim()})` : ''}`));
          return;
        }
        const text = stdout.trim();
        if (!text) {
          reject(new Error('claude -p returned no output'));
          return;
        }
        resolve(text);
      },
    );
    child.stdin.write(transcriptText);
    child.stdin.end();
  });
}

// Original provider: any OpenAI-compatible /chat/completions endpoint (Ollama, LM Studio, or a
// hosted provider that accepts bearer auth). CHAT_API_KEY is optional — omit it for a local
// unauthenticated endpoint like Ollama's default.
async function summarizeViaOpenAi(turns) {
  const transcriptText = turns.map((t) => `${t.role}: ${t.text}`).join('\n\n').slice(-MAX_TRANSCRIPT_CHARS);
  const headers = { 'content-type': 'application/json' };
  if (CHAT_API_KEY) headers.authorization = `Bearer ${CHAT_API_KEY}`;
  const res = await fetch(`${CHAT_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
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

// Used when the summarizer is unreachable/fails — still worth storing *something* rather than
// losing the session entirely (design-philosophy: never lose data over a soft dependency).
function fallbackSummary(turns) {
  const firstUser = turns.find((t) => t.role === 'user');
  const preview = firstUser ? firstUser.text.slice(0, 300) : '(no user message found)';
  return `Session ended (${turns.length} turns); summarization was unavailable so no summary `
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
  // Recursion guard: the claude-cli provider sets this in its own child's env, and --safe-mode
  // already disables hooks there — this is the belt-and-suspenders second layer in case a future
  // change ever runs this script without --safe-mode.
  if (process.env.DEVSESSION_DISABLE === '1') return;

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
