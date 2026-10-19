// Census browser app. Reads sweeps through the local JSON API; the only action
// that spends SearchApi credits is "Start sweep".

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
};
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const KIND_LABEL = { own: "own site", social: "social profile", booking: "booking platform", none: "no website" };

const state = {
  projects: [],
  active: null,
  sweepId: null,
  data: null,
  status: null,
  filters: { website: "all", phone: "all", minRating: "", minReviews: "", inside: true, search: "" },
  sort: { key: "reviews", dir: -1 },
  limit: 100,
  timer: null,
};

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function notice(text, ok = false) {
  const n = $("#notice");
  if (!text) return (n.hidden = true);
  n.hidden = false;
  n.className = `notice${ok ? " ok" : ""}`;
  n.textContent = text;
}

async function loadStatus() {
  state.status = await api("/api/status");
  const { envKey, browserKey, usage } = state.status;
  $("#usage").textContent = `${usage.liveCalls} request${usage.liveCalls === 1 ? "" : "s"}`;
  $("#usage").title = `Live requests to SearchApi since the first sweep. This server session: ${usage.sessionCalls}.`;
  const ks = $("#key-status");
  ks.textContent = envKey ? "key from .env" : browserKey ? "key connected" : "no key";
  ks.className = `pill${envKey || browserKey ? "" : " warn"}`;
  $("#connect-key").hidden = envKey;
}

async function loadProjects() {
  const { projects } = await api("/api/projects");
  state.projects = projects;
  if (!state.active || !projects.some((p) => p.id === state.active)) state.active = projects[0]?.id || null;
  renderTabs();
  await loadSweep();
}

function renderTabs() {
  $("#tabs").replaceChildren(
    ...state.projects.map((p) =>
      el("button", { class: `tab${p.id === state.active ? " active" : ""}`, onclick: () => { state.active = p.id; state.sweepId = null; renderTabs(); loadSweep(); } }, p.name),
    ),
    state.projects.length ? el("button", { class: "tab", onclick: () => openProjectDialog(state.projects.find((p) => p.id === state.active)) }, "Edit") : null,
  );
}

async function loadSweep() {
  const project = state.projects.find((p) => p.id === state.active);
  if (!project) {
    $("#view").replaceChildren(el("div", { class: "empty", html: "No projects yet. Click <b>Add project</b>: a category, a city as a bounding box, and the grid step." }));
    return;
  }
  const qs = new URLSearchParams({ project: project.id });
  if (state.sweepId) qs.set("id", state.sweepId);
  state.data = await api(`/api/sweep?${qs}`);
  state.sweepId = state.data.manifest?.id || null;
  render(project);
  clearTimeout(state.timer);
  // Poll while a sweep runs here or in a terminal (the manifest says so).
  if (state.data.running || state.data.manifest?.status === "running") state.timer = setTimeout(() => { loadStatus(); loadSweep(); }, 2500);
}

function render(project) {
  const view = $("#view");
  const d = state.data;
  const size = areaSize(project.area);
  const head = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("div", {}, [
        el("h2", {}, [`“${project.q}” in ${project.area.label}`, el("span", {}, `${project.gl.toUpperCase()} · ${project.hl}`)]),
        el("div", { class: "card-meta" }, `${size.widthKm.toFixed(0)} × ${size.heightKm.toFixed(0)} km · grid ${d.grid.rows} × ${d.grid.cols} = ${d.grid.cells.length} cells, ${project.stepKm} km apart, ${project.radiusM} m radius, up to ${project.maxPages} pages per cell · at most ${project.plan.maxRequests} requests`),
      ]),
      el("div", { class: "card-actions" }, [
        sweepSelector(project),
        d.running
          ? el("button", { onclick: () => stopSweep() }, "Stop sweep")
          : el("button", { class: "primary", onclick: () => startSweep(project) }, d.manifest ? "New sweep" : "Start sweep"),
        d.manifest && ["stopped", "failed"].includes(d.manifest.status) ? el("button", { onclick: () => startSweep(project, d.manifest.id) }, "Resume") : null,
      ]),
    ]),
  ]);
  view.replaceChildren(head);
  if (!d.manifest) {
    view.append(el("div", { class: "empty", html: `No sweep yet. <b>Start sweep</b> sends one request per cell and page (at most ${project.plan.maxRequests} here) and saves every raw response in <code>.data/sweeps/${project.id}/</code>. Or run <code>npm run sweep -- --project=${project.id}</code>.` }));
    return;
  }
  const m = d.manifest;
  const kinds = { own: 0, social: 0, booking: 0, none: 0 };
  for (const p of d.inside) kinds[p.websiteKind] += 1;
  const doneCells = m.doneCells.length;
  head.append(
    el("div", { class: "stats" }, [
      stat(d.inside.length, `unique businesses inside ${project.area.label}`, true),
      stat(d.requests, "requests so far"),
      stat(`${doneCells}/${m.grid.planned}`, "cells finished"),
      stat(d.outside.length, "returned outside the area (not counted)"),
      stat(kinds.none + kinds.social + kinds.booking, "without their own website"),
      stat(d.seenInMoreThanOneCell, "seen from more than one cell"),
    ]),
    el("div", { class: "progress" }, el("i", { style: `width:${Math.round((doneCells / Math.max(1, m.grid.planned)) * 100)}%` })),
    el("div", { class: "sweep-line" }, [
      el("span", {}, `Sweep ${when(m.startedAt)} · ${m.status}${m.error ? ` · ${m.error}` : ""}${m.finishedAt ? ` · finished ${when(m.finishedAt)}` : " · live, refreshing"}`),
    ]),
  );

  const grid = el("div", { class: "grid" }, [
    el("div", {}, [el("h3", {}, "The grid"), mapSvg(project, d), legend(kinds)]),
    el("div", {}, [el("h3", {}, "Unique businesses as requests go by"), curveSvg(d), el("div", { class: "chart-note" }, "When the curve flattens, more requests stop finding new businesses: that is what “covered” looks like.")]),
  ]);
  view.append(el("div", { class: "card" }, [grid, el("div", { class: "cells-note" }, cellsNote(d))]));

  view.append(el("div", { class: "card" }, [el("h3", {}, "Businesses"), filtersBar(), el("div", { id: "table" })]));
  renderTable();
}

function stat(value, label, accent = false) {
  return el("div", { class: `stat${accent ? " accent" : ""}` }, [el("b", {}, value), el("span", {}, label)]);
}

function areaSize(a) {
  const mid = (a.north + a.south) / 2;
  return { heightKm: (a.north - a.south) * 111.32, widthKm: (a.east - a.west) * 111.32 * Math.cos((mid * Math.PI) / 180) };
}

function sweepSelector(project) {
  if (!project.sweeps?.length) return null;
  const sel = el("select", { onchange: (e) => { state.sweepId = e.target.value; loadSweep(); } });
  for (const s of project.sweeps) sel.append(el("option", { value: s.id, selected: s.id === state.sweepId }, `${when(s.startedAt)} · ${s.uniqueInside} found · ${s.requests} req · ${s.status}`));
  return sel;
}

function cellsNote(d) {
  const stops = {};
  for (const c of d.cells) if (c.stop) stops[c.stop] = (stops[c.stop] || 0) + 1;
  const parts = Object.entries(stops).map(([k, v]) => `${v} ${k}`);
  return parts.length ? `Why cells stopped: ${parts.join(", ")}. Darker cells added more new businesses; dots are where the businesses are.` : "Darker cells added more new businesses; dots are where the businesses are.";
}

function mapSvg(project, d) {
  const a = project.area;
  const size = areaSize(a);
  const W = 520, H = Math.round((W * size.heightKm) / size.widthKm);
  const x = (lng) => ((lng - a.west) / (a.east - a.west)) * W;
  const y = (lat) => ((a.north - lat) / (a.north - a.south)) * H;
  const s = svg("svg", { class: "map", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Grid cells and businesses" });
  const byId = new Map(d.cells.map((c) => [c.id, c]));
  const done = new Set(d.manifest.doneCells);
  const max = Math.max(1, ...d.cells.map((c) => c.newInside));
  const cw = W / d.grid.cols, ch = H / d.grid.rows;
  for (const c of d.grid.cells) {
    const st = byId.get(c.id);
    const cls = ["cell", done.has(c.id) ? "done" : "", st && st.newInside > max * 0.5 ? "hot" : "", st && !done.has(c.id) ? "active" : ""].join(" ").trim();
    const r = svg("rect", { class: cls, x: c.col * cw, y: c.row * ch, width: cw, height: ch });
    r.append(svg("title"));
    r.querySelector("title").textContent = st ? `${c.id}: ${st.pages} page${st.pages === 1 ? "" : "s"}, ${st.newInside} new businesses${st.stop ? `, stopped: ${st.stop}` : ""}` : `${c.id}: not requested yet`;
    s.append(r);
  }
  const f = state.filters;
  for (const p of d.inside) {
    if (p.lat === null) continue;
    const dim = !passes(p, f);
    s.append(svg("circle", { class: `pin ${p.websiteKind}${dim ? " dim" : ""}`, cx: x(p.lng).toFixed(1), cy: y(p.lat).toFixed(1), r: 1.8 }));
  }
  return s;
}

function legend(kinds) {
  return el("div", { class: "legend" }, Object.entries(KIND_LABEL).map(([k, label]) => el("span", {}, [el("i", { class: `pin ${k}`, style: `background:${{ own: "#6366f1", social: "#d97706", booking: "#0d9488", none: "#b91c1c" }[k]}` }), `${label} · ${kinds[k]}`])));
}

function curveSvg(d) {
  const W = 520, H = 220, pad = { l: 44, r: 12, t: 10, b: 26 };
  const s = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}` });
  const pts = d.curve;
  if (!pts.length) return s;
  const maxX = Math.max(pts.length, 10), maxY = Math.max(10, ...pts.map((p) => p.unique));
  const x = (i) => pad.l + ((i) / maxX) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - (v / maxY) * (H - pad.t - pad.b);
  for (let i = 0; i <= 4; i++) {
    const v = Math.round((maxY / 4) * i);
    s.append(svg("line", { class: "gridline", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    const t = svg("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end" });
    t.textContent = v;
    s.append(t);
  }
  const tx = svg("text", { x: W - pad.r, y: H - 6, "text-anchor": "end" });
  tx.textContent = `${pts.length} requests`;
  s.append(tx);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i + 1).toFixed(1)},${y(p.unique).toFixed(1)}`).join(" ");
  s.append(svg("path", { class: "series", d: path, stroke: "#4f46e5" }));
  const last = pts[pts.length - 1];
  s.append(svg("circle", { class: "dot", cx: x(pts.length), cy: y(last.unique), r: 3.5, fill: "#4f46e5" }));
  return s;
}

function filtersBar() {
  const f = state.filters;
  const upd = (k) => (e) => { f[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value; state.limit = 100; renderTable(); refreshPins(); };
  const sel = (id, label, options, key) => el("div", {}, [el("label", { for: id }, label), (() => { const s = el("select", { id, onchange: upd(key) }); for (const [v, t] of options) s.append(el("option", { value: v, selected: f[key] === v }, t)); return s; })()]);
  return el("div", { class: "filters" }, [
    sel("f-website", "Website on the listing", [["all", "any"], ["gap", "not their own (none, social or booking)"], ["none", "none"], ["social", "social profile"], ["booking", "booking platform"], ["own", "own site"]], "website"),
    sel("f-phone", "Phone", [["all", "any"], ["missing", "missing"], ["present", "present"]], "phone"),
    el("div", {}, [el("label", { for: "f-rating" }, "Min rating"), el("input", { id: "f-rating", type: "number", step: "0.1", min: 1, max: 5, value: f.minRating, placeholder: "4.5", oninput: upd("minRating") })]),
    el("div", {}, [el("label", { for: "f-reviews" }, "Min reviews"), el("input", { id: "f-reviews", type: "number", min: 0, value: f.minReviews, placeholder: "50", oninput: upd("minReviews") })]),
    el("div", {}, [el("label", { for: "f-search" }, "Search"), el("input", { id: "f-search", type: "search", value: f.search, placeholder: "name, address, category", oninput: upd("search") })]),
    el("span", { class: "count", id: "f-count" }),
    el("button", { onclick: downloadCsv }, "Download CSV"),
  ]);
}

function passes(p, f) {
  if (f.website === "gap" && p.websiteKind === "own") return false;
  if (["none", "social", "booking", "own"].includes(f.website) && p.websiteKind !== f.website) return false;
  if (f.phone === "missing" && p.phone) return false;
  if (f.phone === "present" && !p.phone) return false;
  if (f.minRating !== "" && !(p.rating !== null && p.rating >= Number(f.minRating))) return false;
  if (f.minReviews !== "" && !(p.reviews !== null && p.reviews >= Number(f.minReviews))) return false;
  if (f.search) {
    const s = f.search.toLowerCase();
    if (![p.title, p.address, p.category, p.domain].some((v) => String(v || "").toLowerCase().includes(s))) return false;
  }
  return true;
}

function filtered() {
  const rows = state.data.inside.filter((p) => passes(p, state.filters));
  const { key, dir } = state.sort;
  return rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va === null || va === undefined || va === "") return 1;
    if (vb === null || vb === undefined || vb === "") return -1;
    return (typeof va === "number" ? va - vb : String(va).localeCompare(String(vb))) * dir;
  });
}

function refreshPins() {
  const map = $(".map");
  if (!map) return;
  const f = state.filters;
  const pins = map.querySelectorAll(".pin");
  let i = 0;
  for (const p of state.data.inside) {
    if (p.lat === null) continue;
    pins[i]?.classList.toggle("dim", !passes(p, f));
    i += 1;
  }
}

function renderTable() {
  const rows = filtered();
  $("#f-count").textContent = `${rows.length} of ${state.data.inside.length}`;
  const cols = [["title", "Business"], ["category", "Category"], ["rating", "Rating"], ["reviews", "Reviews"], ["websiteKind", "Website"], ["phone", "Phone"], ["address", "Address"], ["cells", "Cells"], ["source", ""]];
  const th = (key, label) => el("th", { class: state.sort.key === key ? "sorted" : "", onclick: () => { state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === "title" || key === "address" ? 1 : -1 }; renderTable(); } }, label + (state.sort.key === key ? (state.sort.dir > 0 ? " ↑" : " ↓") : ""));
  const table = el("table", { class: "places" }, [
    el("thead", {}, el("tr", {}, cols.map(([k, l]) => (l ? th(k, l) : el("th"))))),
    el("tbody", {}, rows.slice(0, state.limit).map((p) =>
      el("tr", {}, [
        el("td", {}, [p.title, p.price ? el("span", { class: "muted" }, ` ${p.price}`) : null]),
        el("td", { class: "muted" }, p.category),
        el("td", { class: "num" }, p.rating === null ? el("span", { class: "muted" }, "unknown") : p.rating.toFixed(1)),
        el("td", { class: "num" }, p.reviews === null ? el("span", { class: "muted" }, "unknown") : p.reviews),
        el("td", {}, [el("span", { class: `kind ${p.websiteKind}` }, KIND_LABEL[p.websiteKind]), p.website ? el("a", { href: p.website, target: "_blank", rel: "noopener nofollow", class: "hit-link" }, p.domain || p.website) : null]),
        el("td", {}, p.phone || el("span", { class: "muted" }, "unknown")),
        el("td", { class: "muted" }, p.address),
        el("td", { class: "num muted", title: p.cells.join(", ") }, p.cells.length),
        el("td", {}, [el("a", { href: p.source, target: "_blank", rel: "noopener" }, "Maps ↗"), " ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); showRaw(p); } }, "raw")]),
      ]),
    )),
  ]);
  const wrap = $("#table");
  wrap.replaceChildren(table);
  if (rows.length > state.limit) wrap.append(el("div", { class: "more" }, el("button", { onclick: () => { state.limit += 200; renderTable(); } }, `Show more (${rows.length - state.limit} left)`)));
}

async function showRaw(p) {
  const file = `${state.data.manifest.project}/${state.data.manifest.id}/${p.firstCell}-p${String(p.firstPage).padStart(2, "0")}.json`;
  try {
    const raw = await api(`/api/raw?file=${encodeURIComponent(file)}`);
    const hit = (raw.response.local_results || []).find((r) => r.place_id === p.placeId) || raw.response;
    $("#raw-title").textContent = `${file} · ${when(raw.capturedAt)}`;
    $("#raw-body").textContent = JSON.stringify({ request: raw.params, result: hit }, null, 2);
    $("#raw-dialog").showModal();
  } catch (e) {
    notice(e.message);
  }
}

function downloadCsv() {
  const rows = filtered();
  const cols = ["title", "category", "rating", "reviews", "websiteKind", "website", "domain", "phone", "address", "lat", "lng", "placeId", "source", "cells"];
  const esc = (v) => {
    let s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(" ") : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
  const m = state.data.manifest;
  const a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `census-${m.project}-${m.startedAt.slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
}

async function startSweep(project, resume = null) {
  const msg = resume
    ? `Resume this sweep? It continues from the first unfinished cell. Each request costs 1 credit.`
    : `Start a new sweep of “${project.q}” in ${project.area.label}? ${project.plan.cells} cells, at most ${project.plan.maxRequests} requests (1 credit each). Cells stop early when results leave the area or add nothing new.`;
  if (!confirm(msg)) return;
  try {
    const { id } = await api("/api/sweep", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: project.id, resume }) });
    state.sweepId = id;
    notice("");
    await loadProjects();
  } catch (e) {
    notice(e.message);
  }
}

async function stopSweep() {
  try {
    await api("/api/sweep/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: state.sweepId }) });
    notice("Sweep stopping after the current request. Everything already saved stays on disk.", true);
  } catch (e) {
    notice(e.message);
  }
}

function openProjectDialog(p = null) {
  const v = (id, val) => ($(id).value = val ?? "");
  v("#p-name", p?.name); v("#p-q", p?.q); v("#p-gl", p?.gl || "us"); v("#p-hl", p?.hl || "en");
  v("#p-label", p?.area?.label); v("#p-north", p?.area?.north); v("#p-south", p?.area?.south); v("#p-east", p?.area?.east); v("#p-west", p?.area?.west);
  v("#p-step", p?.stepKm ?? 3); v("#p-radius", p?.radiusM ?? 1500); v("#p-pages", p?.maxPages ?? 5); v("#p-inside", p?.minInside ?? 5); v("#p-new", p?.minNew ?? 2);
  $("#project-dialog").dataset.id = p?.id || "";
  $("#project-dialog").showModal();
}

$("#add-project").addEventListener("click", () => openProjectDialog());
$("#p-cancel").addEventListener("click", () => $("#project-dialog").close());
$("#project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    id: $("#project-dialog").dataset.id || undefined,
    name: $("#p-name").value, q: $("#p-q").value, gl: $("#p-gl").value, hl: $("#p-hl").value,
    area: { label: $("#p-label").value, north: $("#p-north").value, south: $("#p-south").value, east: $("#p-east").value, west: $("#p-west").value },
    stepKm: $("#p-step").value, radiusM: $("#p-radius").value, maxPages: $("#p-pages").value, minInside: $("#p-inside").value, minNew: $("#p-new").value,
  };
  try {
    const { project, plan } = await api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    $("#project-dialog").close();
    state.active = project.id;
    state.sweepId = null;
    notice(`Saved. ${plan.cells} cells, at most ${plan.maxRequests} requests per sweep.`, true);
    await loadProjects();
  } catch (err) {
    notice(err.message);
  }
});
$("#connect-key").addEventListener("click", () => $("#key-dialog").showModal());
$("#key-cancel").addEventListener("click", () => $("#key-dialog").close());
$("#key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: $("#key-input").value }) });
  $("#key-input").value = "";
  $("#key-dialog").close();
  await loadStatus();
});
$("#raw-close").addEventListener("click", () => $("#raw-dialog").close());

try {
  await loadStatus();
  await loadProjects();
} catch (e) {
  notice(e.message);
}
