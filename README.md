# EveSynapse status

A public status page for [EveSynapse](https://evesynapse.app). It is hosted on Cloudflare Pages, apart from the EveSynapse servers, so it still loads when they are down.

Once a minute the page asks each server listed in `config.js` (the EveSynapse app and the EveSynapse API) for its `/status.json`, and shows each service with its state: working, degraded or down. A server that does not answer is reported as unreachable, and its services are shown as unknown, never as working. The page keeps the last 60 checks in the visitor's browser as a strip of colored ticks.

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

The app reports the database, the background worker, notifications, the EVE API (ESI), the market sweeps and, when it has push set up, browser push. Any other service id is shown as written; add a label for it in `LABELS` in `status.js`.

## Deploying on Cloudflare Pages

1. In the Cloudflare dashboard, open **Workers & Pages**, choose **Create**, then **Pages**, then **Connect to Git**, and pick this repository.
2. Set the build settings:
   - Framework preset: **None**
   - Build command: leave empty
   - Build output directory: `/` (the repository root)
3. Save and deploy. Every push to the main branch deploys again.
4. Optional: under **Custom domains**, add a domain such as `status.evesynapse.app`.

### Choosing the servers

`config.js` lists the servers, each with a name and its public address (scheme and host only). When you add, remove or change one, change two places in the same commit:

- the `sources` list in `config.js`;
- `connect-src` in the Content-Security-Policy meta tag in `index.html`. The browser blocks a check to any address not listed there.

### Letting each server answer the page

A server only lets one other site's pages read its `/status.json`. On the EveSynapse app, set the page's address, scheme and host only, and restart:

```
STATUS_PAGE_ORIGIN=https://status.evesynapse.app
```

Use the Pages address (`https://<project>.pages.dev`) if there is no custom domain. The API service needs the same origin allowed. Without it the page reports that server as unreachable even while it is up.

## Trying it locally

Serve the folder with any static file server and open it. For a local server, point a source and `connect-src` at its address (for example `http://127.0.0.1:8080`), serve this page on another port, and start the server with `STATUS_PAGE_ORIGIN` set to this page's address.
