// Runs index.js end-to-end against a mock LifeContext ingest server and a stub `claude` CLI on
// PATH (no real API usage, no local LLM required). Covers: claude-cli summarizer success,
// DEVSESSION_DISABLE recursion guard, claude-cli failure -> fallback summary, openai provider
// request shape (with/without CHAT_API_KEY), and the PreCompact/SessionEnd dedup path from #4
// (same source_id, distinct extra.hook_event).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TRANSCRIPT_LINES = [
  { message: { role: 'user', content: [{ type: 'text', text: 'fixed the login bug by adding a null check' }] } },
  { message: { role: 'assistant', content: [{ type: 'text', text: 'confirmed, tests pass' }] } },
];

function writeFixtureTranscript(dir) {
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, TRANSCRIPT_LINES.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return transcriptPath;
}

// Executable stub `claude` on a fresh temp dir prepended to PATH, so execFile('claude', ...)
// resolves to it instead of a real CLI. Drains stdin (the transcript) and either prints a canned
// summary or exits non-zero to exercise the fallback-summary path.
function writeStubClaudeDir({ exitCode = 0 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'devsession-stub-claude-'));
  const lines = ['#!/usr/bin/env bash', 'cat >/dev/null'];
  lines.push(exitCode === 0
    ? 'echo "STUB SUMMARY: session summarized by the test double."'
    : `echo "stub-claude: simulated failure" >&2; exit ${exitCode}`);
  const scriptPath = path.join(dir, 'claude');
  writeFileSync(scriptPath, lines.join('\n') + '\n');
  chmodSync(scriptPath, 0o755);
  return dir;
}

function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      (handler ?? ((_req, _body, res2) => res2.end('{}')))(req, parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

// Async spawn, not spawnSync: spawnSync would block this process's event loop, but the mock
// HTTP server the child talks to (started via http.createServer in THIS process) can only
// respond by running that very event loop — spawnSync here would deadlock the child.
function runHook(hookInput, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

test('claude-cli provider: summarizes via the claude CLI, ingests the summary, exits 0', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'devsession-test-'));
  const transcriptPath = writeFixtureTranscript(tmp);
  const stubDir = writeStubClaudeDir();
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    { session_id: 'test-session-1', transcript_path: transcriptPath, cwd: '/tmp/some-project', hook_event_name: 'SessionEnd', reason: 'clear' },
    {
      LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
      LIFECONTEXT_API_KEY: 'test-key',
      CHAT_PROVIDER: 'claude-cli',
      CHAT_MODEL: 'haiku',
      PATH: `${stubDir}:${process.env.PATH}`,
    },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const payload = requests[0].body;
  assert.equal(payload.source, 'devsession-claude');
  assert.equal(payload.source_id, 'test-session-1');
  assert.equal(payload.type, 'dev_session');
  assert.equal(payload.text_repr, 'STUB SUMMARY: session summarized by the test double.');
  assert.equal(payload.extra.hook_event, 'SessionEnd');
  assert.equal(payload.extra.project, 'some-project');

  rmSync(tmp, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

test('DEVSESSION_DISABLE=1 short-circuits before reading the transcript or posting to ingest', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'devsession-test-'));
  const transcriptPath = writeFixtureTranscript(tmp);
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    { session_id: 'test-session-2', transcript_path: transcriptPath, cwd: '/tmp/some-project' },
    { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key', DEVSESSION_DISABLE: '1' },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 0, 'the recursion guard must return before any ingest call');

  rmSync(tmp, { recursive: true, force: true });
});

test('claude-cli summarizer failure falls back to a fallback summary, still exits 0', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'devsession-test-'));
  const transcriptPath = writeFixtureTranscript(tmp);
  const stubDir = writeStubClaudeDir({ exitCode: 1 });
  const { server, port, requests } = await startMockServer();

  const result = await runHook(
    { session_id: 'test-session-3', transcript_path: transcriptPath, cwd: '/tmp/some-project', hook_event_name: 'SessionEnd', reason: 'clear' },
    {
      LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
      LIFECONTEXT_API_KEY: 'test-key',
      CHAT_PROVIDER: 'claude-cli',
      PATH: `${stubDir}:${process.env.PATH}`,
    },
  );

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.text_repr, /summarization was unavailable/);

  rmSync(tmp, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

test('openai provider: unchanged request shape, no Authorization header when CHAT_API_KEY is unset', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'devsession-test-'));
  const transcriptPath = writeFixtureTranscript(tmp);
  const { server: ingestServer, port: ingestPort, requests: ingestRequests } = await startMockServer();
  const { server: chatServer, port: chatPort, requests: chatRequests } = await startMockServer(
    (_req, _body, res) => res.end(JSON.stringify({ choices: [{ message: { content: 'OPENAI STUB SUMMARY' } }] })),
  );

  const result = await runHook(
    { session_id: 'test-session-4', transcript_path: transcriptPath, cwd: '/tmp/some-project' },
    {
      LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
      LIFECONTEXT_API_KEY: 'test-key',
      CHAT_PROVIDER: 'openai',
      CHAT_BASE_URL: `http://127.0.0.1:${chatPort}/v1`,
    },
  );

  ingestServer.closeAllConnections(); ingestServer.close();
  chatServer.closeAllConnections(); chatServer.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ingestRequests[0].body.text_repr, 'OPENAI STUB SUMMARY');
  assert.equal(chatRequests[0].headers.authorization, undefined);

  rmSync(tmp, { recursive: true, force: true });
});

test('openai provider: sends bearer auth when CHAT_API_KEY is set', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'devsession-test-'));
  const transcriptPath = writeFixtureTranscript(tmp);
  const { server: ingestServer, port: ingestPort } = await startMockServer();
  const { server: chatServer, port: chatPort, requests: chatRequests } = await startMockServer(
    (_req, _body, res) => res.end(JSON.stringify({ choices: [{ message: { content: 'OPENAI STUB SUMMARY' } }] })),
  );

  const result = await runHook(
    { session_id: 'test-session-5', transcript_path: transcriptPath, cwd: '/tmp/some-project' },
    {
      LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
      LIFECONTEXT_API_KEY: 'test-key',
      CHAT_PROVIDER: 'openai',
      CHAT_BASE_URL: `http://127.0.0.1:${chatPort}/v1`,
      CHAT_API_KEY: 'sk-test',
    },
  );

  ingestServer.closeAllConnections(); ingestServer.close();
  chatServer.closeAllConnections(); chatServer.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(chatRequests[0].headers.authorization, 'Bearer sk-test');

  rmSync(tmp, { recursive: true, force: true });
});

test('PreCompact then SessionEnd for the same session_id ingest under the same source_id, with distinct extra.hook_event (#4)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'devsession-test-'));
  const transcriptPath = writeFixtureTranscript(tmp);
  const stubDir = writeStubClaudeDir();
  const { server, port, requests } = await startMockServer();
  const env = { LIFECONTEXT_URL: `http://127.0.0.1:${port}`, LIFECONTEXT_API_KEY: 'test-key', PATH: `${stubDir}:${process.env.PATH}` };

  const precompact = await runHook(
    { session_id: 'dedup-test', transcript_path: transcriptPath, cwd: '/tmp/some-project', hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null },
    env,
  );
  const sessionEnd = await runHook(
    { session_id: 'dedup-test', transcript_path: transcriptPath, cwd: '/tmp/some-project', hook_event_name: 'SessionEnd', reason: 'clear' },
    env,
  );

  server.closeAllConnections();
  server.close();
  assert.equal(precompact.status, 0, precompact.stderr);
  assert.equal(sessionEnd.status, 0, sessionEnd.stderr);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.source_id, 'dedup-test');
  assert.equal(requests[1].body.source_id, 'dedup-test');
  assert.equal(requests[0].body.extra.hook_event, 'PreCompact');
  assert.equal(requests[1].body.extra.hook_event, 'SessionEnd');

  rmSync(tmp, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});
