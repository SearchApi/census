// Sweep a whole city: every grid cell, page after page, one request each.
//
//   npm run sweep -- --project=austin-barbershops
//   npm run sweep -- --project=austin-barbershops --dry-run        (prints the grid and the request ceiling, sends nothing)
//   npm run sweep -- --project=austin-barbershops --max-cells=3    (a taste: only the first cells)
//   npm run sweep -- --project=austin-barbershops --resume=<sweep id>

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../server/store.mjs";
import { Usage } from "../server/searchapi.mjs";
import { runSweep, planSweep } from "../server/sweeper.mjs";
import { areaSizeKm } from "../server/grid.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // the key may already be in the environment
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);

const store = new Store({ dataDir: path.join(root, ".data"), projectsFile: path.join(root, "projects.json") });
await store.init();
const usage = new Usage(path.join(root, ".data"));
const apiKey = process.env.SEARCHAPI_API_KEY || "";

const projects = await store.loadProjects();
const project = projects.find((p) => p.id === args.project) || (projects.length === 1 && !args.project ? projects[0] : null);
if (!project) {
  console.error(args.project ? `Project "${args.project}" is not in projects.json.` : `Pick a project: ${projects.map((p) => p.id).join(", ") || "(projects.json is empty)"}.`);
  process.exit(1);
}

const plan = planSweep(project);
const size = areaSizeKm(project.area);
const maxCells = Number(args["max-cells"]) || 0;
const planned = maxCells ? Math.min(maxCells, plan.cells) : plan.cells;
console.log(`${project.name}: "${project.q}" over ${project.area.label} (${size.widthKm.toFixed(0)} × ${size.heightKm.toFixed(0)} km).`);
console.log(`Grid: ${plan.grid.rows} × ${plan.grid.cols} = ${plan.cells} cells, ${project.stepKm} km apart, ${project.radiusM} m radius, up to ${project.maxPages} pages each.`);
console.log(`This run: ${planned} cell${planned === 1 ? "" : "s"}, at most ${planned * project.maxPages} requests (1 credit each). A cell stops early on a short page, when results leave the area, or when a page adds nothing new.`);
if (args["dry-run"] === "true") {
  console.log("Dry run: nothing sent.");
  process.exit(0);
}
if (!apiKey) {
  console.error("No SEARCHAPI_API_KEY. Copy .env.example to .env and paste your key.");
  process.exit(1);
}

const before = (await usage.read()).liveCalls;
const t0 = Date.now();
try {
  const manifest = await runSweep({
    store,
    usage,
    apiKey,
    project,
    sweepId: args.resume || undefined,
    maxCells,
    onPage: (r) => {
      const stop = r.stop ? ` · stop: ${r.stop}` : "";
      console.log(`${String(r.requests).padStart(4)}  ${r.cell.id} p${r.page}  ${r.rows} rows, ${r.inside} in area, ${r.newInside} new  →  ${r.unique} unique${stop}  [${r.cellsDone}/${r.cellsPlanned} cells]`);
    },
  });
  console.log(`\nFinished sweep ${manifest.id}: ${manifest.uniqueInside} unique businesses inside ${project.area.label} after ${manifest.requests} requests in ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
  console.log(`Open http://127.0.0.1:${process.env.PORT || 5201} or run npm run report.`);
} catch (e) {
  console.error(`\nStopped: ${e.message}`);
  console.error("Resume with: npm run sweep -- --project=" + project.id + " --resume=<sweep id printed in .data/sweeps/" + project.id + ">");
  process.exitCode = 1;
}
const after = (await usage.read()).liveCalls;
console.log(`Live requests this run: ${after - before}. Total since the first sweep: ${after}.`);
