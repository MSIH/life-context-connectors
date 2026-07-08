// Shared by scan.js and caption-worker.js so both build the exact same base description —
// drift here would mean the caption worker's "enriched" upsert contradicts the scanner's
// original text instead of extending it.
import exifr from 'exifr';
import { reverseGeocode } from './reverse-geocode.js';

export async function describePhoto(absPath) {
  // exifr resolves to undefined (not an error) when the file has no EXIF/GPS at all.
  const parsed = await exifr.parse(absPath, { pick: ['DateTimeOriginal'] }).catch(() => undefined);
  const gps = await exifr.gps(absPath).catch(() => undefined);
  const date = parsed?.DateTimeOriginal instanceof Date ? parsed.DateTimeOriginal : null;
  const dateStr = date ? date.toISOString().slice(0, 10) : null;
  const place = gps ? reverseGeocode(gps.latitude, gps.longitude) : null;
  return {
    date,
    dateStr,
    place,
    latitude: gps?.latitude ?? null,
    longitude: gps?.longitude ?? null,
  };
}

export function buildTextRepr(dateStr, place, filename) {
  if (dateStr && place) return `Photo taken ${dateStr} ${place.startsWith('near ') ? place : `in ${place}`}`;
  if (dateStr) return `Photo taken ${dateStr}`;
  if (place) return `Photo ${place.startsWith('near ') ? place : `taken in ${place}`}`;
  return `Photo: ${filename}`;
}
