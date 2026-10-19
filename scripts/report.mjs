// Markdown summary of the latest sweep (or one by id). Reads from disk, no requests.
//
//   npm run report
//   npm run report -- --project=austin-barbershops --sweep=<id> --top=15

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../server/store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const store = new Store({ dataDir: path.join(root, ".data"), projectsFile: path.join(root, "projects.json") });
const top = Number(args.top) || 10;

let projects = await store.loadProjects();
if (args.project) projects = projects.filter((p) => p.id === args.project);

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "0%");
const day = (iso) => (iso || "").slice(0, 10);

for (const p of projects) {
  console.log(`# ${p.name} (${p.id})\n`);
  const sweeps = await store.listSweeps(p.id);
  const id = args.sweep || sweeps[0]?.id;
  if (!id) {
    console.log("No sweeps yet.\n");
    continue;
  }
  const s = await store.loadSweep(p, id);
  const m = s.manifest;
  const inside = s.inside;
  const kinds = { none: 0, social: 0, booking: 0, own: 0 };
  for (const x of inside) kinds[x.websiteKind] += 1;
  const noPhone = inside.filter((x) => !x.phone).length;
  console.log(`"${p.q}" in ${p.area.label} · sweep ${day(m.startedAt)} · ${m.status}${m.error ? ` (${m.error})` : ""}\n`);
  console.log(`- ${inside.length} unique businesses inside the area after ${s.requests} requests (${s.cells.length} of ${m.grid.planned} cells, ${s.seenInMoreThanOneCell} seen from more than one cell).`);
  console.log(`- ${s.outside.length} more were returned outside the area and are not counted.`);
  console.log(`- Website on the listing: ${kinds.own} own site (${pct(kinds.own, inside.length)}), ${kinds.social} social profile (${pct(kinds.social, inside.length)}), ${kinds.booking} booking or ordering platform (${pct(kinds.booking, inside.length)}), ${kinds.none} none (${pct(kinds.none, inside.length)}).`);
  console.log(`- ${noPhone} without a phone number on the listing.\n`);
  const gap = inside.filter((x) => x.websiteKind !== "own" && x.rating !== null && x.reviews !== null).sort((a, b) => b.reviews - a.reviews || b.rating - a.rating).slice(0, top);
  console.log(`## Top ${gap.length} without their own website, by review count\n`);
  console.log("| business | rating | reviews | listing website | phone | address |");
  console.log("|---|---|---|---|---|---|");
  for (const x of gap) console.log(`| ${x.title} | ${x.rating ?? "—"} | ${x.reviews ?? "—"} | ${x.websiteKind === "none" ? "none" : `${x.websiteKind}: ${x.domain}`} | ${x.phone || "—"} | ${x.address} |`);
  console.log("\n## Coverage curve (unique businesses after every 25 requests)\n");
  const pts = s.curve.filter((c, i) => i % 25 === 24 || i === s.curve.length - 1);
  console.log(pts.map((c) => `${c.request}:${c.unique}`).join("  "));
  console.log("\nRead these as observations with a date: a listing without a website field does not prove the business has no website.\n");
}
