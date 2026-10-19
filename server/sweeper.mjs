// The sweep: every cell of the grid, page after page, until the cell is done.
// Shared by the CLI (scripts/sweep.mjs) and the browser button (POST /api/sweep).
// Stops at the first error so a bad key never burns the rest of the grid.

import { buildParams, googleMaps } from "./searchapi.mjs";
import { buildGrid, normalizePlace, shouldContinue } from "./grid.mjs";

export function planSweep(project) {
  const grid = buildGrid(project.area, project.stepKm);
  return { grid, cells: grid.cells.length, maxRequests: grid.cells.length * project.maxPages };
}

export async function runSweep({ store, usage, apiKey, project, fetchImpl, sweepId, maxCells = 0, signal, onPage = () => {}, pause = 0 }) {
  const { grid } = planSweep(project);
  const id = sweepId || store.newSweepId();
  const cells = maxCells > 0 ? grid.cells.slice(0, maxCells) : grid.cells;
  const existing = (await store.readManifest(project.id, id)) || null;
  const done = new Set(existing?.doneCells || []);
  const seen = new Set();
  // When resuming, rebuild what was already seen from the saved pages.
  if (existing) {
    for (const p of await store.readPages(project.id, id)) {
      for (const raw of p.response?.local_results || []) {
        const place = normalizePlace(raw, { area: project.area });
        if (place.placeId && place.inside) seen.add(place.placeId);
      }
    }
  }
  const manifest = existing || {
    id,
    project: project.id,
    q: project.q,
    area: project.area,
    gl: project.gl,
    hl: project.hl,
    stepKm: project.stepKm,
    radiusM: project.radiusM,
    maxPages: project.maxPages,
    minInside: project.minInside,
    minNew: project.minNew,
    grid: { rows: grid.rows, cols: grid.cols, cells: grid.cells.length, planned: cells.length },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    requests: 0,
    uniqueInside: 0,
    doneCells: [],
    error: "",
  };
  manifest.status = "running";
  manifest.error = "";
  manifest.finishedAt = null;
  manifest.uniqueInside = seen.size;
  await store.writeManifest(project.id, id, manifest);

  try {
    for (const cell of cells) {
      if (done.has(cell.id)) continue;
      if (signal?.aborted) throw Object.assign(new Error("Sweep stopped."), { status: 499 });
      for (let page = 1; page <= project.maxPages; page++) {
        if (signal?.aborted) throw Object.assign(new Error("Sweep stopped."), { status: 499 });
        const params = buildParams({ q: project.q, lat: cell.lat, lng: cell.lng, radiusM: project.radiusM, gl: project.gl, hl: project.hl, page });
        const response = await googleMaps({ params, apiKey, fetchImpl });
        await usage.record(1);
        manifest.requests += 1;
        const list = response.local_results || [];
        let inside = 0, newInside = 0;
        for (const raw of list) {
          const place = normalizePlace(raw, { area: project.area });
          if (!place.placeId || !place.inside) continue;
          inside += 1;
          if (!seen.has(place.placeId)) {
            seen.add(place.placeId);
            newInside += 1;
          }
        }
        const decision = shouldContinue({ rows: list.length, inside, newInside, page, maxPages: project.maxPages, minInside: project.minInside, minNew: project.minNew });
        const { file } = await store.savePage({ projectId: project.id, sweepId: id, cell, page, params: { ...params }, response, stop: decision.next ? "" : decision.reason });
        manifest.uniqueInside = seen.size;
        if (!decision.next) {
          done.add(cell.id);
          manifest.doneCells = [...done];
        }
        await store.writeManifest(project.id, id, manifest);
        onPage({ file, cell, page, rows: list.length, inside, newInside, unique: seen.size, requests: manifest.requests, stop: decision.next ? "" : decision.reason, cellsDone: done.size, cellsPlanned: cells.length });
        if (!decision.next) break;
        if (pause) await new Promise((r) => setTimeout(r, pause));
      }
    }
    manifest.status = "finished";
    manifest.finishedAt = new Date().toISOString();
    await store.writeManifest(project.id, id, manifest);
    return manifest;
  } catch (e) {
    manifest.status = e.status === 499 ? "stopped" : "failed";
    manifest.error = e.message || String(e);
    manifest.finishedAt = new Date().toISOString();
    await store.writeManifest(project.id, id, manifest);
    throw e;
  }
}
