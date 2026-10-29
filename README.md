# EveSynapse status

A public status page for [EveSynapse](https://evesynapse.app). It is hosted on Cloudflare Pages, apart from the EveSynapse servers, so it still loads when they are down.

Once a minute the page checks, straight from the visitor's browser, each source listed in `config.js`:

- **EveSynapse**: the app's `/status.json`, a state for each of its services.
- **Market API**: the market API's health at `/api/market/v1/health` on its own host, so an unreachable API host shows apart from the main site.
- **EVE Online API (ESI)**: ESI's own Tranquility status, read directly from `esi.evetech.net`, so it still shows when EveSynapse is down.

Each service shows its state: working, degraded or down. A source that does not answer, answers with an error, is blocked by CORS or takes longer than 10 seconds is reported as unreachable, and its services are shown as unknown, never as working. The page keeps the last 60 checks in the visitor's browser as a strip of colored ticks.

Plain HTML, CSS and JavaScript. There is no build step, no Node and no bundler.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page, with the site's wordmark and the Content-Security-Policy meta tag |
| `config.js` | The servers the page checks |
| `status.js` | Fetches each `/status.json` and draws the page |
| `style.css` | The look, in the site's colors and fonts, dark and light |
| `_headers` | Response headers Cloudflare Pages adds |
| `fonts/` | The site's fonts (SIL Open Font License, see `fonts/NOTICE.txt`) |
| `favicon.svg` | The site's icon |

## What a server reports

`GET /status.json` answers without a session, from what the server already holds, rebuilt at most every 30 seconds and rate limited per address:

```json
{
  "state": "ok",
  "checked_at": "2026-10-28T18:00:00Z",
  "services": [
    { "id": "database", "state": "ok", "age": 0 },
    { "id": "worker", "state": "ok", "age": 41 }
  ]
}
```

- `state`: the worst of the services.
- `checked_at`: when the summary was built. An answer more than 5 minutes old counts as no answer.
- Each service has an `id`, a `state` (`ok`, `degraded` or `down`) and an `age`: seconds since it last showed it was working, or `null` when that is not known. Nothing else is reported.

The app reports the database, the background worker, notifications, the EVE API (ESI) as the app sees it, the market sweeps and, when it has push set up, browser push. Any other service id is shown as written; add a label for it in `LABELS` in `status.js`.

The market API answers `GET /api/market/v1/health` with one service, under the same rules:

```json
{ "service": "market_api", "state": "ok", "checked_at": "2026-10-28T18:00:00Z" }
```

ESI's `GET /latest/status/` is EVE Online's own: the page shows Tranquility as working with its player count, or degraded while it is in VIP mode.

## Deploying on Cloudflare Pages

1. In the Cloudflare dashboard, open **Workers & Pages**, choose **Create**, then **Pages**, then **Connect to Git**, and pick this repository.
2. Set the build settings:
   - Framework preset: **None**
   - Build command: leave empty
   - Build output directory: `/` (the repository root)
3. Save and deploy. Every push to the main branch deploys again.
4. Optional: under **Custom domains**, add a domain such as `status.evesynapse.app`.

### Choosing the servers

`config.js` lists the sources, each with a name, its public address (scheme and host only) and a kind (`summary`, the default, for an EveSynapse `/status.json`; `single` for one service's health at `path`; `esi` for ESI). When you add, remove or change an address, change two places in the same commit:

- the `sources` list in `config.js`;
- `connect-src` in the Content-Security-Policy meta tag in `index.html`. The browser blocks a check to any address not listed there.

### Letting each server answer the page

A server only lets one other site's pages read its `/status.json`. On the EveSynapse app, set the page's address, scheme and host only, and restart:

```
STATUS_PAGE_ORIGIN=https://status.evesynapse.app
```

Use the Pages address (`https://<project>.pages.dev`) if there is no custom domain. The market API reads the same `STATUS_PAGE_ORIGIN`, so one value covers both. Without it the page reports those sources as unreachable even while they are up. ESI allows any origin and needs nothing.

### The market API host

The market API is served by the same app on its own host name:

- Set `MARKET_API_HOST` on the app to that host name, for example `MARKET_API_HOST=api.evesynapse.app`. On that host only `/api/` paths answer.
- Give the host its own DNS record, or its own Cloudflare tunnel route, pointing at the same app.
- Keep the Market API `url` in `config.js` and `connect-src` in `index.html` on that same host.

## Trying it locally

Serve the folder with any static file server and open it. For a local server, point a source and `connect-src` at its address (for example `http://127.0.0.1:8080`), serve this page on another port, and start the server with `STATUS_PAGE_ORIGIN` set to this page's address.
