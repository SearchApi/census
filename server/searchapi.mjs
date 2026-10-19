// Thin client for the SearchApi Google Maps API, plus a usage counter.
// Every call costs SearchApi credits. Nothing is cached: a sweep is a dated
// observation of a city, and the store keeps every raw response.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const BASE_URL = "https://www.searchapi.io/api/v1/search";
export const ENGINE = "google_maps";

// One page of one grid cell. `ll` is "@lat,lng,<radius>m": the point the
// results are ranked around. Google ranks by relevance and distance, so a page
// can carry places well outside the radius; the sweeper decides what counts.
export function buildParams({ q, lat, lng, radiusM = 1500, gl = "us", hl = "en", page = 1 }) {
  if (!q || !String(q).trim()) throw Object.assign(new Error("A search term is required."), { status: 400 });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw Object.assign(new Error("A cell needs a latitude and a longitude."), { status: 400 });
  if (!Number.isInteger(page) || page < 1) throw Object.assign(new Error("Page is a positive integer."), { status: 400 });
  const r = Math.min(Math.max(Math.round(radiusM), 62), 18_636_559);
  return { engine: ENGINE, q: String(q).trim(), ll: `@${lat.toFixed(6)},${lng.toFixed(6)},${r}m`, gl, hl, page: String(page) };
}

export async function googleMaps({ params, apiKey, fetchImpl = fetch, timeoutMs = 60_000 }) {
  if (!apiKey) throw Object.assign(new Error("No SearchApi key. Put SEARCHAPI_API_KEY in .env or connect one in the browser."), { status: 401 });
  const url = new URL(BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`SearchApi returned a non-JSON response (${res.status}).`), { status: 502 });
  }
  if (!res.ok || data?.error) {
    throw Object.assign(new Error(data?.error || `SearchApi error ${res.status}`), { status: res.status || 502 });
  }
  if (!Array.isArray(data.local_results)) {
    // An empty cell is a valid answer; a missing array is not.
    if (data.search_information || data.search_metadata) data.local_results = [];
    else throw Object.assign(new Error("The response has no local_results array."), { status: 502 });
  }
  return data;
}

// Counts live requests across runs (the number the video shows on screen).
export class Usage {
  constructor(dataDir) {
    this.file = path.join(dataDir, "usage.json");
    this.sessionCalls = 0;
  }
  async read() {
    let total = { liveCalls: 0 };
    try {
      total = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      // first run
    }
    return { liveCalls: total.liveCalls || 0, sessionCalls: this.sessionCalls };
  }
  async record(n = 1) {
    const current = await this.read();
    this.sessionCalls += n;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ liveCalls: current.liveCalls + n }, null, 2));
  }
}
