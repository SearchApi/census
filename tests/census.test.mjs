import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildGrid, insideArea, classifyWebsite, rootDomain, shouldContinue, aggregate, normalizePlace, toCsv, areaSizeKm } from "../server/grid.mjs";
import { buildParams, Usage } from "../server/searchapi.mjs";
import { Store, validateProject, slug } from "../server/store.mjs";
import { runSweep, planSweep } from "../server/sweeper.mjs";

const austin = { label: "Austin, Texas", north: 30.52, south: 30.1, east: -97.56, west: -97.94 };
const place = (id, lat, lng, extra = {}) => ({ place_id: id, title: id, gps_coordinates: { latitude: lat, longitude: lng }, type: "Barber shop", rating: 4.5, reviews: 100, ...extra });
const response = (rows) => ({ search_metadata: { id: "s" }, search_parameters: { engine: "google_maps" }, local_results: rows });

test("grid covers the box with centred cells", () => {
  const g = buildGrid(austin, 3);
  assert.equal(g.rows, 16);
  assert.ok(g.cols >= 12 && g.cols <= 14);
  assert.equal(g.cells.length, g.rows * g.cols);
  for (const c of g.cells) assert.ok(insideArea(austin, c.lat, c.lng), `cell ${c.id} is inside`);
  assert.equal(g.cells[0].id, "r00c00");
  const size = areaSizeKm(austin);
  assert.ok(size.heightKm > 46 && size.heightKm < 47);
  assert.throws(() => buildGrid({ ...austin, north: 30 }, 3));
  assert.throws(() => buildGrid(austin, 0.1));
});

test("inside the area is a plain box test", () => {
  assert.ok(insideArea(austin, 30.2672, -97.7431));
  assert.ok(!insideArea(austin, 29.76, -95.37)); // Houston
  assert.ok(!insideArea(austin, NaN, -97.7));
});

test("website classification: none, social, booking, own", () => {
  assert.equal(classifyWebsite("", ""), "none");
  assert.equal(classifyWebsite("https://www.facebook.com/OharasPubNYC/", "facebook.com"), "social");
  assert.equal(classifyWebsite("https://andisfadesociety.glossgenius.com/", "glossgenius.com"), "booking");
  assert.equal(classifyWebsite("https://andisfadesociety.glossgenius.com/", ""), "booking"); // derived from the URL
  assert.equal(classifyWebsite("http://honestbarberatx.com/", "honestbarberatx.com"), "own");
  assert.equal(rootDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(rootDomain("www.instagram.com"), "instagram.com");
});

test("a cell stops on a short page, when it leaves the area, when nothing is new, or at max pages", () => {
  const base = { maxPages: 5, minInside: 5, minNew: 2 };
  assert.equal(shouldContinue({ rows: 20, inside: 15, newInside: 10, page: 1, ...base }).next, true);
  assert.equal(shouldContinue({ rows: 12, inside: 12, newInside: 12, page: 1, ...base }).reason, "short page");
  assert.equal(shouldContinue({ rows: 20, inside: 3, newInside: 3, page: 2, ...base }).reason, "left the area");
  assert.equal(shouldContinue({ rows: 20, inside: 15, newInside: 1, page: 2, ...base }).reason, "nothing new");
  assert.equal(shouldContinue({ rows: 20, inside: 15, newInside: 10, page: 5, ...base }).reason, "max pages");
});

test("buildParams formats ll with a radius in meters and never carries empty values", () => {
  const p = buildParams({ q: " barbershops ", lat: 30.2672, lng: -97.7431, radiusM: 1500, gl: "us", hl: "en", page: 2 });
  assert.deepEqual(p, { engine: "google_maps", q: "barbershops", ll: "@30.267200,-97.743100,1500m", gl: "us", hl: "en", page: "2" });
  assert.throws(() => buildParams({ q: "", lat: 1, lng: 1 }));
  assert.throws(() => buildParams({ q: "x", lat: NaN, lng: 1 }));
});

test("aggregate dedupes by place_id, keeps unknown fields unknown, separates outside", () => {
  const pages = [
    { capturedAt: "2026-10-19T00:00:00Z", cellId: "r00c00", lat: 30.5, lng: -97.9, page: 1, response: response([place("a", 30.5, -97.9), place("b", 30.49, -97.91, { website: "https://instagram.com/b", domain: "instagram.com", rating: null, reviews: null, phone: undefined }), place("far", 29.7, -95.3)]) },
    { capturedAt: "2026-10-19T00:00:01Z", cellId: "r00c01", lat: 30.5, lng: -97.87, page: 1, stop: "short page", response: response([place("a", 30.5, -97.9), place("c", 30.5, -97.87, { website: "http://c.com", domain: "c.com" })]) },
  ];
  const r = aggregate(pages, austin);
  assert.equal(r.requests, 2);
  assert.equal(r.inside.length, 3);
  assert.equal(r.outside.length, 1);
  assert.equal(r.seenInMoreThanOneCell, 1);
  const b = r.inside.find((x) => x.placeId === "b");
  assert.equal(b.websiteKind, "social");
  assert.equal(b.rating, null);
  assert.equal(b.phone, "");
  assert.deepEqual(r.curve.map((c) => c.unique), [2, 3]);
  assert.equal(r.cells.find((c) => c.id === "r00c01").stop, "short page");
  assert.equal(r.cells.find((c) => c.id === "r00c01").newInside, 1);
});

test("normalizePlace builds a checkable source link and derives the domain", () => {
  const p = normalizePlace(place("ChIJx", 30.3, -97.7, { website: "https://www.shop.example.com/x", title: "Shop & Co" }), { area: austin, cellId: "r01c01", page: 1 });
  assert.equal(p.domain, "example.com");
  assert.equal(p.websiteKind, "own");
  assert.ok(p.source.includes("query_place_id=ChIJx"));
  assert.ok(p.source.includes(encodeURIComponent("Shop & Co")));
  assert.equal(p.inside, true);
});

test("csv escapes formula-looking cells and quotes commas", () => {
  const csv = toCsv([{ a: "=SUM(1)", b: "x, y", c: null }], ["a", "b", "c"]);
  assert.equal(csv, 'a,b,c\n\'=SUM(1),"x, y",\n');
});

test("validateProject normalizes and rejects bad input", () => {
  const p = validateProject({ name: "Barbershops in Austin", q: "barbershops", gl: "US", area: austin });
  assert.equal(p.id, "barbershops-in-austin");
  assert.equal(p.gl, "us");
  assert.equal(p.stepKm, 3);
  assert.equal(p.maxPages, 5);
  assert.throws(() => validateProject({ name: "x", q: "", area: austin }));
  assert.throws(() => validateProject({ name: "x", q: "y", area: { ...austin, east: -98 } }));
  assert.throws(() => validateProject({ name: "x", q: "y", area: austin, stepKm: 0.2 })); // too many cells
  assert.equal(slug("Café São Paulo"), "cafe-sao-paulo");
});

test("sweep saves one raw file per request, stops cells by the rules, resumes without repeating", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "census-"));
  try {
    const store = new Store({ dataDir: dir, projectsFile: path.join(dir, "projects.json") });
    await store.init();
    const usage = new Usage(dir);
    const project = validateProject({ id: "t", name: "T", q: "barbershops", area: { label: "Tiny", north: 30.30, south: 30.25, east: -97.70, west: -97.76 }, stepKm: 3, maxPages: 3, minInside: 5, minNew: 2 });
    assert.equal(planSweep(project).cells, 4);
    const calls = [];
    // Page 1 of every cell: 20 inside; page 2: 20 rows but mostly outside the area.
    const fetchImpl = async (url) => {
      const page = Number(url.searchParams.get("page"));
      const ll = url.searchParams.get("ll");
      calls.push(`${ll}#${page}`);
      const rows = page === 1
        ? Array.from({ length: 20 }, (_, i) => place(`${ll}-${i}`, 30.27, -97.73))
        : Array.from({ length: 20 }, (_, i) => place(`out-${ll}-${i}`, 29.7, -95.3));
      return { ok: true, status: 200, text: async () => JSON.stringify(response(rows)) };
    };
    const seen = [];
    const m = await runSweep({ store, usage, apiKey: "k", project, fetchImpl, onPage: (r) => seen.push(r) });
    assert.equal(m.status, "finished");
    assert.equal(m.requests, 8); // 4 cells × (page 1 continues, page 2 leaves the area)
    assert.equal(m.uniqueInside, 80);
    assert.equal(seen.filter((r) => r.stop === "left the area").length, 4);
    assert.equal((await usage.read()).liveCalls, 8);
    const files = (await readdir(store.sweepDir("t", m.id))).filter((f) => f !== "sweep.json");
    assert.equal(files.length, 8);
    const loaded = await store.loadSweep(project, m.id);
    assert.equal(loaded.inside.length, 80);
    assert.equal(loaded.outside.length, 80);
    assert.equal(loaded.cells.length, 4);
    // Resuming a finished sweep sends nothing.
    calls.length = 0;
    const again = await runSweep({ store, usage, apiKey: "k", project, fetchImpl, sweepId: m.id });
    assert.equal(calls.length, 0);
    assert.equal(again.requests, 8);
    // A failing key stops at the first request and the manifest says so.
    const bad = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: "Invalid API key" }) });
    await assert.rejects(runSweep({ store, usage, apiKey: "k", project, fetchImpl: bad }), /Invalid API key/);
    const sweeps = await store.listSweeps("t");
    assert.equal(sweeps[0].status, "failed");
    await assert.rejects(store.readRaw("../projects.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
