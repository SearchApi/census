# Census

Every business of one category in a whole city, from the [SearchApi Google Maps API](https://www.searchapi.io/docs/google-maps). One Maps search is one screen of about 20 results. Census tiles the city into a grid, asks for every cell page by page, removes the duplicates by `place_id`, and keeps every raw response on your machine with its date. You get the list, the count, the request count that produced it, and a map that shows when the city is covered.

This is a local example application for developers. It is not a hosted service and not a lead-generation product: it builds a list of public listings, nothing more.

## The API first

One cell, one page, one GET request:

```sh
curl -G https://www.searchapi.io/api/v1/search \
  -H "Authorization: Bearer $SEARCHAPI_API_KEY" \
  --data-urlencode "engine=google_maps" \
  --data-urlencode "q=padarias" \
  --data-urlencode "ll=@-23.694400,-46.565400,1500m" \
  --data-urlencode "gl=br" --data-urlencode "hl=pt-BR" \
  --data-urlencode "page=1"
```

The response has `local_results[]`, each with `place_id`, `title`, `type`, `address`, `phone`, `website`, `domain`, `rating`, `reviews`, `price`, `gps_coordinates`, `open_hours` and more. Parameters worth knowing:

| parameter | what it does |
|---|---|
| `q` | the search term; natural language works (`padarias`, `bakeries in São Bernardo do Campo`, `coffee shops in Austin, Texas`) |
| `ll` | the point the results are ranked around: `@lat,lng,<zoom>z` or `@lat,lng,<radius>m` |
| `gl`, `hl` | country and interface language (`br`, `pt-BR`) |
| `page` | the next 20 results around the same point |

Two things the data taught us, both visible in the app. A page returns about 20 places, so one request is one screen. And pagination does not stop at the city: by page 5 or 6, results around a point in São Bernardo do Campo start coming from hundreds of kilometres away. Google ranks by relevance and distance, not by a hard radius. So a city sweep needs a grid, a geographic stop rule, and deduplication.

## How the sweep works

1. The city is a bounding box (north, south, east, west). Census tiles it into cells `stepKm` apart; each cell is a point.
2. For each cell it requests page 1, 2, 3… with `ll=@lat,lng,<radiusM>m`.
3. A cell stops when a page is short (fewer than 20 rows), when fewer than `minInside` of its rows fall inside the box (the results left the area), when it adds fewer than `minNew` businesses the sweep had not seen, or at `maxPages`.
4. Every page is saved raw as `.data/sweeps/<project>/<sweep id>/<cell>-p<page>.json`. A manifest (`sweep.json`) is rewritten after every request, so the browser can follow a sweep live and a stopped sweep can resume.
5. Places are deduplicated by `place_id`. Places returned outside the box are kept in the files but not counted.

The curve of unique businesses against requests flattens when the city is covered. That flattening is the result; the count is an observation with a date.

## Run locally

You need Git and **Node.js 22 or newer**. No npm packages, no database, no build step.

```sh
git clone https://github.com/SearchApi/census.git
cd census
cp .env.example .env        # paste your SearchApi key
npm run sweep -- --dry-run  # prints the grid and the request ceiling, sends nothing
npm run sweep               # the sweep, one request per cell and page
npm start
```

Open **http://127.0.0.1:5201**. Another port: `PORT=5301 npm start`.

Create a [SearchApi account](https://www.searchapi.io/users/sign_up) and put the key in `.env` as `SEARCHAPI_API_KEY=...`. The key is read by the server and the collector on this machine and never written to a capture. If you prefer, click **Connect key** in the browser; that key lives only in the server's memory.

## Projects

`projects.json` holds the projects: a search term, a city as a bounding box, and the grid settings:

```json
{
  "id": "sbc-padarias",
  "name": "Bakeries in São Bernardo do Campo",
  "q": "padarias",
  "gl": "br", "hl": "pt-BR",
  "area": { "label": "São Bernardo do Campo, SP", "north": -23.65, "south": -23.80, "east": -46.50, "west": -46.62 },
  "stepKm": 2, "radiusM": 1000, "maxPages": 5, "minInside": 5, "minNew": 2
}
```

To get a bounding box, open the city on a map, right-click the north-east and the south-west corners and copy their coordinates. **Add project** in the browser writes the same file and tells you how many cells and requests at most the sweep will take.

Settings in plain words: `stepKm` is how far apart the cells are (smaller: more cells, finer coverage); `radiusM` is the radius sent in `ll` (results still spill beyond it); `maxPages` caps the pages per cell; `minInside` and `minNew` are the stop rules above.

## Sweeping

```sh
npm run sweep -- --project=sbc-padarias
npm run sweep -- --project=sbc-padarias --dry-run
npm run sweep -- --project=sbc-padarias --max-cells=3        # a taste: the first three cells only
npm run sweep -- --project=sbc-padarias --resume=<sweep id>  # continue a stopped or failed sweep
```

Each request is 1 credit. The CLI prints one line per request: cell, page, rows, rows inside the area, new businesses, running total, and why a cell stopped. It stops at the first error so a bad key never burns the rest of the grid. The **Start sweep** button in the browser does the same thing, asks before spending, and shows the grid filling in.

For São Bernardo bakeries with the settings above: 63 cells, at most 315 requests. The real number is lower because most cells stop early; the app shows it.

## Reading the results

The project page shows the unique businesses inside the area, the requests so far, the cells finished, how many returned places fell outside the area, the grid as a map (darker cells added more businesses; dots are the businesses, coloured by what the listing's website is), and the coverage curve. Below it, the table with filters: website on the listing (own site, social profile, booking or ordering platform, none), phone present or missing, minimum rating, minimum reviews, text search. Every row links to the place on Google Maps and to the raw API response it came from. **Download CSV** exports the filtered rows.

`npm run report` prints a Markdown summary of the latest sweep: counts, the website breakdown, the businesses without their own website sorted by review count, and the coverage curve. It reads from disk and costs nothing.

## With Claude

Point Claude Code (or any agent) at the folder and ask, for example:

> Read `.data/sweeps/sbc-padarias` (or run `npm run report -- --project=sbc-padarias`). Which parts of the box have the most bakeries without their own website, and which of those have a rating of 4.5 or more with at least 500 reviews? Short table with the Maps links, and say the sweep date and the request count.

The captures are plain JSON with dates and coordinates, so the answer is checkable. Pair it with the [SearchApi skill for Claude](https://github.com/SamJale/SearchApi-Claude-Plugin) when you want the agent to run new sweeps.

## Reading the numbers honestly

- A sweep is a snapshot of what Google Maps returned on a date for a grid of points. "Found N" is not "there are N"; a finer grid can find more.
- The area is a rectangle, not the city limits: a box around São Bernardo do Campo includes slices of Santo André, São Caetano and Diadema. Say "in the box" or filter by address if the limit matters.
- A listing without a website field does not prove the business has no website. A social or booking link as the website is a fact about the listing, not a verdict on the business.
- Ratings and review counts are observations, not lead scores.
- Census does no contact enrichment, no email guessing and no outreach. What you do with a public listing is on you; be a decent person about it.

## Project layout

```
projects.json        projects: search term, bounding box, grid settings
scripts/start.mjs    local server (static files + JSON API), 127.0.0.1:5201
scripts/sweep.mjs    sweep CLI, one request per cell and page
scripts/report.mjs   Markdown summary from disk
server/searchapi.mjs SearchApi client and usage counter
server/grid.mjs      grid, inside-the-box test, website classification, aggregation, CSV
server/store.mjs     sweeps on disk, manifest, project validation
server/sweeper.mjs   the sweep loop and its stop rules
server/routes.mjs    the JSON API
public/              the browser app (no framework, no build)
tests/               node --test
.data/               sweeps and usage counter (not committed)
```

`npm run check` runs syntax checks and the tests.

## License

MIT. Built by the SearchApi developer advocacy team as a companion to the video on the Google Maps API.
