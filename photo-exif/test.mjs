// Synthesizes JPEGs with injected EXIF (piexifjs — no real photo library needed) and runs
// scan.js / caption-worker.js against them with mock ingest/VLM servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import piexif from 'piexifjs';
import { reverseGeocode } from './lib/reverse-geocode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+; this connector declares >=18

// A minimal valid 1x1 JPEG (no EXIF) — piexifjs inserts EXIF into a real JPEG rather than
// building one from scratch.
const BASE_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

function jpegWithExif({ dateTimeOriginal, lat, lon } = {}) {
  const binaryStr = Buffer.from(BASE_JPEG_BASE64, 'base64').toString('binary');
  const exifObj = { '0th': {}, Exif: {}, GPS: {} };
  if (dateTimeOriginal) exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] = dateTimeOriginal;
  if (lat != null && lon != null) {
    exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
    exifObj.GPS[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lat));
    exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = lon >= 0 ? 'E' : 'W';
    exifObj.GPS[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lon));
  }
  const exifBytes = piexif.dump(exifObj);
  return Buffer.from(piexif.insert(exifBytes, binaryStr), 'binary');
}

function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, body: parsed });
      handler(req, parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('reverseGeocode: exact, near, and out-of-range', () => {
  assert.equal(reverseGeocode(30.2672, -97.7431), 'Austin, TX');
  assert.equal(reverseGeocode(0, -140), null); // mid-Pacific, nothing in the dataset nearby
  assert.equal(reverseGeocode(null, null), null);
});

test('scan.js: EXIF + GPS photo, GPS-only photo, no-metadata photo, unchanged-file skip', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-test-'));
  writeFileSync(path.join(tmp, 'with-both.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00', lat: 30.2672, lon: -97.7431 }));
  writeFileSync(path.join(tmp, 'gps-only.jpg'), jpegWithExif({ lat: 51.5074, lon: -0.1278 }));
  writeFileSync(path.join(tmp, 'no-metadata.jpg'), Buffer.from(BASE_JPEG_BASE64, 'base64'));

  const { server, port, requests } = await startMockServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      summary: {},
      results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  });

  const manifestPath = path.join(tmp, 'manifest.json');
  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: manifestPath,
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  const artifacts = requests[0].body.artifacts;
  assert.equal(artifacts.length, 3);

  const both = artifacts.find((a) => a.source_id === 'with-both.jpg');
  assert.equal(both.type, 'photo');
  assert.equal(both.text_repr, 'Photo taken 2019-03-04 in Austin, TX');
  assert.equal(both.occurred_at, '2019-03-04T14:30:00.000Z');
  assert.equal(both.latitude, 30.2672);
  assert.equal(both.place_label, 'Austin, TX');
  assert.match(both.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(both.extra.captioned, false);

  const gpsOnly = artifacts.find((a) => a.source_id === 'gps-only.jpg');
  assert.equal(gpsOnly.text_repr, 'Photo taken in London, UK');
  assert.equal(gpsOnly.occurred_at, undefined); // no date -> omitted, never guessed from mtime

  const noMeta = artifacts.find((a) => a.source_id === 'no-metadata.jpg');
  assert.equal(noMeta.text_repr, 'Photo: no-metadata.jpg');
  assert.equal(noMeta.latitude, undefined);

  // Re-run with the same (populated) manifest: nothing changed on disk, so nothing re-sent.
  requests.length = 0;
  const { server: server2, port: port2, requests: requests2 } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({ summary: {}, results: [] }));
  });
  const rerun = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port2}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: manifestPath,
  });
  server2.closeAllConnections();
  server2.close();
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(requests2.length, 0, 'unchanged files are skipped on re-scan');
});

test('scan.js: same filename in different subdirectories gets distinct source_ids', async () => {
  // Regression test: walkImageFiles() used to recompute relPath relative to the CURRENT
  // recursion directory rather than the original root, so "2019/trip/IMG_1234.jpg" and
  // "2020/trip/IMG_1234.jpg" both collapsed to source_id "IMG_1234.jpg" and silently
  // overwrote each other via upsert instead of being two artifacts.
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-nested-test-'));
  mkdirSync(path.join(tmp, '2019', 'trip'), { recursive: true });
  mkdirSync(path.join(tmp, '2020', 'trip'), { recursive: true });
  writeFileSync(path.join(tmp, '2019', 'trip', 'IMG_1234.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  writeFileSync(path.join(tmp, '2020', 'trip', 'IMG_1234.jpg'), jpegWithExif({ dateTimeOriginal: '2020:03:04 14:30:00' }));

  const { server, port, requests } = await startMockServer((req, body, res) => {
    res.end(JSON.stringify({
      summary: {},
      results: body.artifacts.map((_, i) => ({ id: i + 1, created: true, resolved_entities: 0, unresolved_aliases: 0 })),
    }));
  });

  const result = await run('scan.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${port}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_MANIFEST_PATH: path.join(tmp, 'manifest.json'),
  });
  server.closeAllConnections();
  server.close();
  assert.equal(result.status, 0, result.stderr);

  const artifacts = requests[0].body.artifacts;
  assert.equal(artifacts.length, 2, 'two distinct photos, not one collapsed into the other');
  const ids = artifacts.map((a) => a.source_id).sort();
  assert.deepEqual(ids, ['2019/trip/IMG_1234.jpg', '2020/trip/IMG_1234.jpg']);
});

test('caption-worker.js: enriches text_repr in place, preserves EXIF fields via upsert semantics, kill-safe state', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-caption-test-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00', lat: 30.2672, lon: -97.7431 }));

  const ingestRequests = [];
  const { server: ingestServer, port: ingestPort } = await startMockServer((req, body, res) => {
    ingestRequests.push(body);
    res.end(JSON.stringify({ id: 1, created: false, resolved_entities: 0, unresolved_aliases: 0 }));
  });

  const vlmRequests = [];
  const vlmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      vlmRequests.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: 'two people cooking pasta in a kitchen' }));
    });
  });
  const vlmPort = await new Promise((resolve) => vlmServer.listen(0, '127.0.0.1', () => resolve(vlmServer.address().port)));

  const statePath = path.join(tmp, 'captions.json');
  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });

  ingestServer.closeAllConnections();
  ingestServer.close();
  vlmServer.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(vlmRequests.length, 1);
  assert.ok(vlmRequests[0].images[0].length > 0, 'sent base64 image data');
  assert.equal(ingestRequests.length, 1);
  const payload = ingestRequests[0];
  assert.equal(payload.source_id, 'photo.jpg');
  assert.equal(payload.text_repr, 'Photo taken 2019-03-04 in Austin, TX two people cooking pasta in a kitchen');
  assert.equal(payload.extra.captioned, true);
  // Upsert-only-what-changed: no occurred_at/latitude/place_label/raw_path/content_hash resent —
  // those were already stored by scan.js and must be left untouched (doc 04 §3 merge semantics).
  assert.equal(payload.occurred_at, undefined);
  assert.equal(payload.latitude, undefined);
  assert.equal(payload.place_label, undefined);

  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), ['photo.jpg']);

  // Re-run: already captioned, VLM should not be called again.
  const rerun = await run('caption-worker.js', {
    LIFECONTEXT_URL: `http://127.0.0.1:${ingestPort}`,
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: `http://127.0.0.1:${vlmPort}`,
    VLM_THROTTLE_MS: '0',
  });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(vlmRequests.length, 1, 'already-captioned photo is not re-sent to the VLM');
});

test('caption-worker.js: VLM unreachable stops the run without marking anything captioned', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'photo-exif-caption-down-'));
  writeFileSync(path.join(tmp, 'photo.jpg'), jpegWithExif({ dateTimeOriginal: '2019:03:04 14:30:00' }));
  const statePath = path.join(tmp, 'captions.json');

  const result = await run('caption-worker.js', {
    LIFECONTEXT_URL: 'http://127.0.0.1:19999',
    LIFECONTEXT_API_KEY: 'test-key',
    PHOTO_ROOT: tmp,
    PHOTO_EXIF_CAPTION_STATE_PATH: statePath,
    VLM_BASE_URL: 'http://127.0.0.1:19998', // nothing listening
    VLM_THROTTLE_MS: '0',
  });

  assert.equal(result.status, 0, result.stderr); // stops cleanly, not a crash
  assert.throws(() => readFileSync(statePath, 'utf8')); // nothing was captioned
});
