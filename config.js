// What this page checks, in the order shown. Each source has a
// name, a public address (scheme and host only) and a kind:
//   summary: an EveSynapse server's /status.json (the default kind)
//   single:  one service's health, at path (the market API)
//   esi:     EVE Online's own API status, checked directly
// When you add, remove or change an address, change connect-src in
// index.html's Content-Security-Policy to match, or the browser
// blocks the check.
window.STATUS_CONFIG = {
  sources: [
    { name: "EveSynapse", url: "https://evesynapse.app" },
    { name: "Market API", url: "https://api.evesynapse.app", kind: "single", path: "/api/market/v1/health" },
    { name: "EVE Online API (ESI)", url: "https://esi.evetech.net", kind: "esi" }
  ]
};
