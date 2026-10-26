// Sweeps on disk.
//
// Layout: .data/sweeps/<project>/<sweep id>/<cell>-p<page>.json  (one raw response each)
//         .data/sweeps/<project>/<sweep id>/sweep.json            (manifest, rewritten after every request)
// A sweep id is its start timestamp. Nothing is ever overwritten except the manifest.

import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { validateArea, buildGrid, aggregate } from "./grid.mjs";

export function slug(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";
}

export function validateProject(input) {
  const name = String(input?.name || "").trim();
  if (!name) throw Object.assign(new Error("The project needs a name."), { status: 400 });
  const q = String(input?.q || "").trim();
  if (!q) throw Object.assign(new Error("The project needs a search term, such as padarias."), { status: 400 });
  const gl = String(input.gl || "us").toLowerCase();
  const hl = String(input.hl || "en").toLowerCase();
  if (!/^[a-z]{2}$/.test(gl)) throw Object.assign(new Error("Country (gl) is a two-letter code, such as us."), { status: 400 });
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(hl)) throw Object.assign(new Error("Language (hl) looks like en or pt-br."), { status: 400 });
  const area = validateArea(input.area);
  const num = (v, d, min, max, label) => {
    const n = v === undefined || v === null || v === "" ? d : Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw Object.assign(new Error(`${label} must be between ${min} and ${max}.`), { status: 400 });
    return n;
  };
  const stepKm = num(input.stepKm, 3, 0.2, 50, "Step (km)");
  const radiusM = Math.round(num(input.radiusM, 1500, 62, 50_000, "Radius (m)"));
  const maxPages = Math.round(num(input.maxPages, 5, 1, 20, "Max pages"));
  const minInside = Math.round(num(input.minInside, 5, 0, 20, "Min inside"));
  const minNew = Math.round(num(input.minNew, 2, 0, 20, "Min new"));
  const grid = buildGrid(area, stepKm);
  if (grid.cells.length > 2000) throw Object.assign(new Error(`${grid.cells.length} cells is too many; raise the step or shrink the area.`), { status: 400 });
  return { id: slug(input.id || name), name, q, gl, hl, area, stepKm, radiusM, maxPages, minInside, minNew };
}

export class Store {
  constructor({ dataDir, projectsFile }) {
    this.dataDir = dataDir;
    this.sweepsDir = path.join(dataDir, "sweeps");
    this.projectsFile = projectsFile;
  }

  async init() {
    await mkdir(this.sweepsDir, { recursive: true });
  }

  async loadProjects() {
    try {
      const data = JSON.parse(await readFile(this.projectsFile, "utf8"));
      return Array.isArray(data.projects) ? data.projects.map((p) => validateProject(p)) : [];
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  async saveProjects(projects) {
    await writeFile(this.projectsFile, JSON.stringify({ projects }, null, 2) + "\n");
  }

  async upsertProject(project) {
    const projects = await this.loadProjects();
    const clean = validateProject(project);
    const i = projects.findIndex((p) => p.id === clean.id);
    if (i >= 0) projects[i] = clean;
    else projects.push(clean);
    await this.saveProjects(projects);
    return clean;
  }

  sweepDir(projectId, sweepId) {
    return path.join(this.sweepsDir, slug(projectId), sweepId);
  }

  newSweepId(now = new Date()) {
    return now.toISOString().replace(/[:.]/g, "-");
  }

  async writeManifest(projectId, sweepId, manifest) {
    const dir = this.sweepDir(projectId, sweepId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "sweep.json"), JSON.stringify(manifest, null, 2));
  }

  async readManifest(projectId, sweepId) {
    try {
      return JSON.parse(await readFile(path.join(this.sweepDir(projectId, sweepId), "sweep.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async savePage({ projectId, sweepId, cell, page, params, response, stop = "", capturedAt = new Date().toISOString() }) {
    const dir = this.sweepDir(projectId, sweepId);
    await mkdir(dir, { recursive: true });
    const name = `${cell.id}-p${String(page).padStart(2, "0")}.json`;
    const saved = { capturedAt, project: projectId, sweep: sweepId, cellId: cell.id, lat: cell.lat, lng: cell.lng, page, params, stop, response };
    await writeFile(path.join(dir, name), JSON.stringify(saved, null, 2));
    return { file: path.relative(this.sweepsDir, path.join(dir, name)), saved };
  }

  async listSweeps(projectId) {
    const dir = path.join(this.sweepsDir, slug(projectId));
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = await this.readManifest(projectId, e.name);
      if (m) out.push(m);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // Pages in request order (file names sort by cell then page; capturedAt breaks ties).
  async readPages(projectId, sweepId) {
    const dir = this.sweepDir(projectId, sweepId);
    let files = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== "sweep.json");
    } catch {
      return [];
    }
    const pages = [];
    for (const f of files) pages.push(JSON.parse(await readFile(path.join(dir, f), "utf8")));
    return pages.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.cellId.localeCompare(b.cellId) || a.page - b.page);
  }

  async loadSweep(project, sweepId) {
    const manifest = await this.readManifest(project.id, sweepId);
    if (!manifest) throw Object.assign(new Error("Sweep not found."), { status: 404 });
    const pages = await this.readPages(project.id, sweepId);
    const result = aggregate(pages, project.area);
    return { manifest, ...result };
  }

  async readRaw(relative) {
    const file = path.normalize(path.join(this.sweepsDir, relative));
    if (!file.startsWith(this.sweepsDir + path.sep) || !file.endsWith(".json")) {
      throw Object.assign(new Error("Not a capture file."), { status: 400 });
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw Object.assign(new Error("Capture not found."), { status: 404 });
    return JSON.parse(await readFile(file, "utf8"));
  }
}
