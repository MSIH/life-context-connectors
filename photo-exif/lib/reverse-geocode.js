// Fully offline reverse geocoding: nearest-city lookup against a small bundled dataset
// (lib/places.json, ~100 major world cities), never a network call — per doc 03's privacy
// tiering, location data never leaves the machine. This is deliberately coarse: it resolves
// to the nearest *major* city, not a precise address. See README.md "Known limitations".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACES = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'places.json'), 'utf8'),
);

const EARTH_RADIUS_KM = 6371;
const NEARBY_KM = 50; // within this, name the city plainly
const FAR_KM = 300; // beyond this, the dataset has nothing useful to say

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns a place_label string, or null if the dataset has nothing within FAR_KM (an honest
// "don't know" rather than mislabeling a photo with a city hundreds of km away).
export function reverseGeocode(lat, lon) {
  if (lat == null || lon == null) return null;
  let nearest = null;
  let nearestKm = Infinity;
  for (const place of PLACES) {
    const km = haversineKm(lat, lon, place.lat, place.lon);
    if (km < nearestKm) {
      nearest = place;
      nearestKm = km;
    }
  }
  if (!nearest || nearestKm > FAR_KM) return null;
  const label = nearest.region ? `${nearest.city}, ${nearest.region}` : `${nearest.city}, ${nearest.country}`;
  return nearestKm > NEARBY_KM ? `near ${label}` : label;
}
