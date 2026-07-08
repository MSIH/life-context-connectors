// Seeds a synthetic chat.db (real iMessage schema) and runs index.js against it with mock
// ingest servers, since there's no macOS box in CI/dev to test against a real one. Covers:
// plain text, attributedBody-only text, a photo attachment, a group-chat outgoing message,
// cursor advancement, and idempotent re-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import bplistCreator from 'bplist-creator';

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const toAppleNs = (isoString) => (Date.parse(isoString) - APPLE_EPOCH_MS) * 1e6;

function seedChatDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      handle_id INTEGER, is_from_me INTEGER, date INTEGER, cache_has_attachments INTEGER
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);

  db.prepare('INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)').run(1, '+15550142', 'iMessage');
  db.prepare('INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)').run(2, 'sarah@example.com', 'iMessage');

  db.prepare('INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (?, ?, ?)').run(1, 'group-chat-guid', 'chat123456789');
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(1, 1);
  db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(1, 2);

  // 1: plain-text incoming message
  db.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (1, 'msg-1', 'Landed! See you at the gate.', 1, 0, ?, 0)`)
    .run(toAppleNs('2026-07-01T18:22:09Z'));

  // 2: attributedBody-only incoming message (text column NULL)
  const archive = bplistCreator({
    '$archiver': 'NSKeyedArchiver', '$version': 100000,
    '$objects': ['$null', { NSString: 'placeholder' }, 'Running 10 minutes late, sorry!',
      'NSAttributedString', 'NSObject', 'NSMutableAttributedString', 'NSString',
      '__kIMMessagePartAttributeName'],
    '$top': { root: 1 },
  });
  db.prepare(`INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (2, 'msg-2', NULL, ?, 1, 0, ?, 0)`)
    .run(archive, toAppleNs('2026-07-01T18:25:00Z'));

  // 3: outgoing message with a photo attachment
  db.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (3, 'msg-3', 'Check this out', 1, 1, ?, 1)`)
    .run(toAppleNs('2026-07-01T19:00:00Z'));
  db.prepare(`INSERT INTO attachment (ROWID, filename, mime_type) VALUES (1, '~/Library/Messages/Attachments/ab/photo.jpg', 'image/jpeg')`).run();
  db.prepare(`INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (3, 1)`).run();

  // 4: outgoing group-chat message with no direct handle_id (fallback to chat participants)
  db.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (4, 'msg-4', 'See everyone Friday', NULL, 1, ?, 0)`)
    .run(toAppleNs('2026-07-01T19:05:00Z'));
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 4)').run();

  // 5: a tapback/reaction-shaped row — no text, no attachment — must be skipped entirely
  db.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
              VALUES (5, 'msg-5', NULL, 1, 0, ?, 0)`)
    .run(toAppleNs('2026-07-01T19:06:00Z'));

  db.close();
}

function startMockServer(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      received.push(parsed);
      handler(parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })));
}

// Async spawn, not spawnSync: spawnSync blocks this process's entire event loop until the
// child exits, but the mock HTTP server the child talks to (started via `http.createServer`
// in THIS process) can only respond by running that very event loop — spawnSync here would
// deadlock the child against its own test's server.
function runConnector(env, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'index.js'), ...extraArgs], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('backfill: syncs messages + photo, hints resolved, tapback skipped, cursor advances', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'imessage-test-'));
  const dbPath = path.join(tmp, 'chat.db');
  const statePath = path.join(tmp, 'cursor.json');
  seedChatDb(dbPath);

  const { server, port, received } = await startMockServer((body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      summary: { created: body.artifacts.length, updated: 0, failed: 0 },
      results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  });

  const result = await runConnector({
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    IMESSAGE_DB_PATH: dbPath,
    IMESSAGE_STATE_PATH: statePath,
  });

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(received.length, 1, 'one batch call for a small page');
  const artifacts = received[0].artifacts;

  // msg 1: plain text, sender hint
  const msg1 = artifacts.find((a) => a.source_id === 'chat.db:msg:1');
  assert.equal(msg1.type, 'message');
  assert.match(msg1.text_repr, /Landed! See you at the gate\./);
  assert.deepEqual(msg1.entity_hints, [{ alias: '+15550142', alias_type: 'phone', role: 'sender' }]);

  // msg 2: attributedBody-decoded text
  const msg2 = artifacts.find((a) => a.source_id === 'chat.db:msg:2');
  assert.match(msg2.text_repr, /Running 10 minutes late, sorry!/);

  // msg 3 + its photo attachment
  const msg3 = artifacts.find((a) => a.source_id === 'chat.db:msg:3');
  assert.equal(msg3.entity_hints[0].role, 'recipient');
  const photo = artifacts.find((a) => a.source_id === 'chat.db:attachment:1');
  assert.equal(photo.type, 'photo');
  // Assert the tilde was actually expanded to $HOME, not just "doesn't start with ~" — that
  // weaker check would still pass for a wrongly-rooted absolute path.
  assert.equal(photo.raw_path, path.join(homedir(), 'Library/Messages/Attachments/ab/photo.jpg'));

  // msg 4: group-chat fallback hints both participants
  const msg4 = artifacts.find((a) => a.source_id === 'chat.db:msg:4');
  assert.equal(msg4.entity_hints.length, 2);
  assert.deepEqual(new Set(msg4.entity_hints.map((h) => h.alias)), new Set(['+15550142', 'sarah@example.com']));

  // msg 5 (tapback-shaped, no text/attachment) never sent
  assert.equal(artifacts.find((a) => a.source_id === 'chat.db:msg:5'), undefined);

  // cursor advanced to the last ROWID
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).lastRowId, 5);

  rmSync(tmp, { recursive: true, force: true });
});

test('re-run after cursor advanced sends nothing new (no duplicate work)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'imessage-test-'));
  const dbPath = path.join(tmp, 'chat.db');
  const statePath = path.join(tmp, 'cursor.json');
  seedChatDb(dbPath);
  writeFileSync(statePath, JSON.stringify({ lastRowId: 5 }));

  const { server, port, received } = await startMockServer((body, res) => {
    res.end(JSON.stringify({ summary: {}, results: [] }));
  });

  const result = await runConnector({
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    IMESSAGE_DB_PATH: dbPath,
    IMESSAGE_STATE_PATH: statePath,
  });

  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(received.length, 0, 'nothing past the cursor to sync');

  rmSync(tmp, { recursive: true, force: true });
});

test('ingest failure aborts the page without advancing the cursor', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'imessage-test-'));
  const dbPath = path.join(tmp, 'chat.db');
  const statePath = path.join(tmp, 'cursor.json');
  seedChatDb(dbPath);

  const { server, port } = await startMockServer((body, res) => {
    res.statusCode = 500;
    res.end('{}');
  });

  const result = await runConnector({
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    IMESSAGE_DB_PATH: dbPath,
    IMESSAGE_STATE_PATH: statePath,
  });

  server.closeAllConnections();
  server.close();
  assert.notEqual(result.status, 0);
  assert.throws(() => readFileSync(statePath, 'utf8'), 'cursor file never written');

  rmSync(tmp, { recursive: true, force: true });
});
