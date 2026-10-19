// JSON API for the browser. Everything reads from disk except POST /api/sweep,
// which spends SearchApi credits, and POST /api/projects, which edits projects.json.

import { runSweep, planSweep } from "./sweeper.mjs";

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw Object.assign(new Error("Body too large."), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

export function createRoutes({ store, usage, envKey }) {
  // A key pasted in the browser lives only in this process.
  let browserKey = "";
  const apiKey = () => envKey() || browserKey;
  // One sweep at a time per server; the browser polls the manifest.
  const running = new Map(); // sweepId -> AbortController

  async function findProject(id) {
    const project = (await store.loadProjects()).find((p) => p.id === id);
    if (!project) throw Object.assign(new Error(`Project ${id} not found.`), { status: 404 });
    return project;
  }

  return async function handle(req, res, url) {
    try {
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/api/status") {
        return send(res, 200, { envKey: Boolean(envKey()), browserKey: Boolean(browserKey), usage: await usage.read(), running: [...running.keys()] });
      }

      if (req.method === "POST" && pathname === "/api/key") {
        const body = await readJson(req);
        browserKey = String(body.key || "").trim();
        return send(res, 200, { ok: true, browserKey: Boolean(browserKey) });
      }

      if (req.method === "GET" && pathname === "/api/projects") {
        const projects = await store.loadProjects();
        const out = [];
        for (const p of projects) out.push({ ...p, plan: { cells: planSweep(p).cells, maxRequests: planSweep(p).maxRequests }, sweeps: await store.listSweeps(p.id) });
        return send(res, 200, { projects: out });
      }

      if (req.method === "POST" && pathname === "/api/projects") {
        const saved = await store.upsertProject(await readJson(req));
        return send(res, 200, { project: saved, plan: planSweep(saved) });
      }

      if (req.method === "GET" && pathname === "/api/sweep") {
        const project = await findProject(url.searchParams.get("project"));
        const sweeps = await store.listSweeps(project.id);
        const id = url.searchParams.get("id") || sweeps[0]?.id;
        if (!id) return send(res, 200, { project: project.id, sweep: null, grid: planSweep(project).grid });
        const data = await store.loadSweep(project, id);
        return send(res, 200, { project: project.id, grid: planSweep(project).grid, ...data, running: running.has(id) });
      }

      if (req.method === "POST" && pathname === "/api/sweep") {
        const body = await readJson(req);
        const project = await findProject(body.project);
        if (running.size) throw Object.assign(new Error("A sweep is already running on this server."), { status: 409 });
        const key = apiKey();
        if (!key) throw Object.assign(new Error("No SearchApi key. Put SEARCHAPI_API_KEY in .env or connect one in the browser."), { status: 401 });
        const id = body.resume || store.newSweepId();
        const controller = new AbortController();
        running.set(id, controller);
        runSweep({ store, usage, apiKey: key, project, sweepId: id, maxCells: Number(body.maxCells) || 0, signal: controller.signal })
          .catch(() => {})
          .finally(() => running.delete(id));
        return send(res, 202, { id, plan: planSweep(project) });
      }

      if (req.method === "POST" && pathname === "/api/sweep/stop") {
        const body = await readJson(req);
        const c = running.get(body.id);
        if (!c) throw Object.assign(new Error("That sweep is not running."), { status: 404 });
        c.abort();
        return send(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/api/raw") {
        return send(res, 200, await store.readRaw(url.searchParams.get("file") || ""));
      }

      return send(res, 404, { error: "Unknown API route." });
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 500);
      return send(res, status, { error: e.message || "Unexpected error." });
    }
  };
}
