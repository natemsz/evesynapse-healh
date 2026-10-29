// The servers this page checks, in the order they are shown. Each
// one serves /status.json. url is the public address, scheme and
// host only. When you add, remove or change one, change connect-src
// in index.html's Content-Security-Policy to match, or the browser
// blocks the check.
window.STATUS_CONFIG = {
  sources: [
    { name: "EveSynapse", url: "https://evesynapse.app" },
    { name: "EveSynapse API", url: "https://api.evesynapse.app" }
  ]
};
