// Local server: static files from public/ plus the JSON API in server/routes.mjs.
// Listens on 127.0.0.1 only. Reading sweeps is free; starting one spends credits.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { Store } from "../server/store.mjs";
import { Usage } from "../server/searchapi.mjs";
import { createRoutes } from "../server/routes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const dataDir = path.join(root, ".data");
const port = Number(process.env.PORT || 5201);
const host = "127.0.0.1";

try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // no .env: the key can be connected in the browser
}

const store = new Store({ dataDir, projectsFile: path.join(root, "projects.json") });
await store.init();
const usage = new Usage(dataDir);
const handleApi = createRoutes({ store, usage, envKey: () => process.env.SEARCHAPI_API_KEY || "" });

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(res, url.pathname);
});

server.listen(port, host, () => {
  console.log(`Census is running at http://${host}:${port}`);
  console.log(process.env.SEARCHAPI_API_KEY ? "SearchApi key loaded from .env." : "No SearchApi key in .env: connect one in the browser to sweep.");
  console.log(`Sweeps live in ${path.join(dataDir, "sweeps")}`);
});
