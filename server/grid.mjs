// Pure geometry and classification. No disk, no network.
//
// A city is a bounding box. The grid tiles it with points stepKm apart; each
// point is a cell the sweeper asks Google Maps about. A place belongs to the
// census when its coordinates fall inside the box.

export const KM_PER_DEG_LAT = 111.32;

export function kmPerDegLng(lat) {
  return KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export function validateArea(area) {
  const a = {
    label: String(area?.label || "").trim(),
    north: Number(area?.north),
    south: Number(area?.south),
    east: Number(area?.east),
    west: Number(area?.west),
  };
  for (const k of ["north", "south", "east", "west"]) {
    if (!Number.isFinite(a[k])) throw Object.assign(new Error(`Area ${k} must be a number.`), { status: 400 });
  }
  if (a.north <= a.south) throw Object.assign(new Error("Area north must be greater than south."), { status: 400 });
  if (a.east <= a.west) throw Object.assign(new Error("Area east must be greater than west (no antimeridian crossing)."), { status: 400 });
  if (Math.abs(a.north) > 85 || Math.abs(a.south) > 85) throw Object.assign(new Error("Latitudes must stay within ±85."), { status: 400 });
  return a;
}

export function areaSizeKm(area) {
  const mid = (area.north + area.south) / 2;
  return {
    heightKm: (area.north - area.south) * KM_PER_DEG_LAT,
    widthKm: (area.east - area.west) * kmPerDegLng(mid),
  };
}

// Cells are centred inside the box: the first row starts half a step in.
export function buildGrid(area, stepKm) {
  const a = validateArea(area);
  const step = Number(stepKm);
  if (!Number.isFinite(step) || step < 0.2) throw Object.assign(new Error("Step must be at least 0.2 km."), { status: 400 });
  const mid = (a.north + a.south) / 2;
  const dLat = step / KM_PER_DEG_LAT;
  const dLng = step / kmPerDegLng(mid);
  const rows = Math.max(1, Math.ceil((a.north - a.south) / dLat));
  const cols = Math.max(1, Math.ceil((a.east - a.west) / dLng));
  const latStep = (a.north - a.south) / rows;
  const lngStep = (a.east - a.west) / cols;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        id: `r${String(r).padStart(2, "0")}c${String(c).padStart(2, "0")}`,
        row: r,
        col: c,
        lat: a.north - latStep * (r + 0.5),
        lng: a.west + lngStep * (c + 0.5),
      });
    }
  }
  return { rows, cols, latStep, lngStep, cells };
}

export function insideArea(area, lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat <= area.north && lat >= area.south && lng <= area.east && lng >= area.west;
}

export function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// A "website" on a Maps listing is often not the business's own site.
export const SOCIAL_DOMAINS = new Set(["facebook.com", "instagram.com", "linktr.ee", "tiktok.com", "x.com", "twitter.com", "youtube.com", "linkedin.com", "pinterest.com", "threads.net", "beacons.ai", "bio.site", "wa.me", "whatsapp.com", "m.me"]);
export const BOOKING_DOMAINS = new Set(["glossgenius.com", "booksy.com", "vagaro.com", "squareup.com", "square.site", "schedulicity.com", "styleseat.com", "fresha.com", "setmore.com", "acuityscheduling.com", "as.me", "calendly.com", "mindbodyonline.com", "theCut.co".toLowerCase(), "thecut.co", "boulevard.io", "joinblvd.com", "resurva.com", "booker.com", "genbook.com", "appointy.com", "yelp.com", "doordash.com", "ubereats.com", "grubhub.com", "toasttab.com", "clover.com", "order.online", "opentable.com", "ifood.com.br", "rappi.com.br", "goomer.app", "lojalocal.com", "anota.ai", "cardapioweb.com", "menudino.com", "delivery.direct", "ifood.com"]);

export function rootDomain(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  // keep two labels, or three for second-level country TLDs (co.uk, com.br)
  const tail = parts.slice(-2).join(".");
  if (/^(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/.test(tail)) return parts.slice(-3).join(".");
  return tail;
}

export function domainOf(website) {
  try {
    return rootDomain(new URL(website).hostname);
  } catch {
    return "";
  }
}

// none: Maps shows no website. social: a profile on a social network.
// booking: an ordering or appointment platform page. own: anything else.
export function classifyWebsite(website, domain) {
  if (!website) return "none";
  const d = rootDomain(domain || domainOf(website));
  if (!d) return "none";
  if (SOCIAL_DOMAINS.has(d)) return "social";
  if (BOOKING_DOMAINS.has(d)) return "booking";
  return "own";
}

export function normalizePlace(raw, { area, cellId, page } = {}) {
  const lat = Number(raw?.gps_coordinates?.latitude);
  const lng = Number(raw?.gps_coordinates?.longitude);
  const website = typeof raw.website === "string" ? raw.website : "";
  const domain = raw.domain ? rootDomain(raw.domain) : domainOf(website);
  const placeId = raw.place_id || raw.data_id || "";
  return {
    placeId,
    dataId: raw.data_id || "",
    title: raw.title || "",
    category: raw.type || (Array.isArray(raw.types) ? raw.types[0] : "") || "",
    types: Array.isArray(raw.types) ? raw.types : [],
    address: raw.address || "",
    phone: raw.phone || "",
    website,
    domain,
    websiteKind: classifyWebsite(website, domain),
    rating: Number.isFinite(Number(raw.rating)) && raw.rating !== null && raw.rating !== undefined ? Number(raw.rating) : null,
    reviews: Number.isFinite(Number(raw.reviews)) && raw.reviews !== null && raw.reviews !== undefined ? Number(raw.reviews) : null,
    price: raw.price || "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    inside: area ? insideArea(area, lat, lng) : null,
    source: placeId ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(raw.title || "place")}&query_place_id=${encodeURIComponent(placeId)}` : "",
    firstCell: cellId || "",
    firstPage: page || null,
  };
}

// Decides whether the sweeper asks for the next page of a cell.
// rows: places on this page; inside: how many fall in the area; newInside: how
// many of those the census had not seen before.
export function shouldContinue({ rows, inside, newInside, page, maxPages, minInside, minNew, pageSize = 20 }) {
  if (page >= maxPages) return { next: false, reason: "max pages" };
  if (rows < pageSize) return { next: false, reason: "short page" };
  if (inside < minInside) return { next: false, reason: "left the area" };
  if (newInside < minNew) return { next: false, reason: "nothing new" };
  return { next: true, reason: "" };
}

// Folds saved pages (in request order) into unique places and per-cell stats.
export function aggregate(pages, area) {
  const places = new Map();
  const cells = new Map();
  const curve = [];
  let requests = 0;
  for (const p of pages) {
    requests += 1;
    const cell = cells.get(p.cellId) || { id: p.cellId, lat: p.lat, lng: p.lng, pages: 0, rows: 0, inside: 0, newInside: 0, stop: "" };
    cell.pages += 1;
    const list = Array.isArray(p.response?.local_results) ? p.response.local_results : [];
    for (const raw of list) {
      const place = normalizePlace(raw, { area, cellId: p.cellId, page: p.page });
      if (!place.placeId) continue;
      cell.rows += 1;
      if (place.inside) cell.inside += 1;
      const seen = places.get(place.placeId);
      if (seen) {
        if (!seen.cells.includes(p.cellId)) seen.cells.push(p.cellId);
        continue;
      }
      places.set(place.placeId, { ...place, cells: [p.cellId] });
      if (place.inside) cell.newInside += 1;
    }
    if (p.stop) cell.stop = p.stop;
    cells.set(p.cellId, cell);
    curve.push({ request: requests, cellId: p.cellId, page: p.page, unique: [...places.values()].filter((x) => x.inside).length });
  }
  const all = [...places.values()];
  return {
    requests,
    places: all,
    inside: all.filter((x) => x.inside),
    outside: all.filter((x) => !x.inside),
    cells: [...cells.values()],
    curve,
    seenInMoreThanOneCell: all.filter((x) => x.inside && x.cells.length > 1).length,
  };
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
