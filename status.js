// EveSynapse status: asks each server in config.js for its
// /status.json once a minute and shows each service's state. A
// server that cannot be reached is reported as unreachable, and
// none of its services is shown as working.
(function () {
  "use strict";

  var POLL_MS = 60 * 1000;
  var TIMEOUT_MS = 10 * 1000;
  // A summary older than this was not built just now (a cache in
  // the way, a clock far off): treat it as no answer.
  var STALE_MS = 5 * 60 * 1000;
  var HISTORY_KEY = "evesynapse-status-history";
  var HISTORY_MAX = 60;

  var LABELS = {
    database: "Database",
    worker: "Background sync",
    notifications: "Notifications",
    esi: "EVE API (ESI)",
    market: "Market data",
    push: "Browser push"
  };
  var ORDER = ["database", "worker", "esi", "market", "notifications", "push"];
  var STATE_WORDS = {
    ok: "Working",
    degraded: "Degraded",
    down: "Down",
    unknown: "Unknown"
  };
  var RANK = { ok: 0, degraded: 1, down: 2, unreachable: 3 };

  var cfg = window.STATUS_CONFIG || {};
  var sources = (Array.isArray(cfg.sources) ? cfg.sources : []).filter(function (s) {
    return s && typeof s.url === "string" && s.url;
  }).map(function (s) {
    return {
      name: String(s.name || s.url),
      url: s.url.replace(/\/+$/, ""),
      bad: [],
      lastIds: null, // service ids of the last answer, for unknown rows
      list: null
    };
  });
  var lastAttempt = 0;
  var timer = 0;
  var history = [];

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ago(seconds) {
    if (seconds < 90) return "just now";
    var m = Math.round(seconds / 60);
    if (m < 90) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  }

  function clock(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function label(id) { return LABELS[id] || id; }

  function setBanner(state, title, detail) {
    $("banner").setAttribute("data-state", state);
    $("banner-title").textContent = title;
    $("banner-detail").textContent = detail;
  }

  function row(name, state, note) {
    var li = el("li", "service");
    li.setAttribute("data-state", state);
    var dot = el("span", "dot");
    dot.setAttribute("aria-hidden", "true");
    li.appendChild(dot);
    li.appendChild(el("span", "name", name));
    li.appendChild(el("span", "state", STATE_WORDS[state] || state));
    li.appendChild(el("span", "age", note || ""));
    return li;
  }

  function buildPanels() {
    var box = $("sources");
    box.textContent = "";
    sources.forEach(function (src) {
      var panel = el("section", "panel");
      panel.appendChild(el("h2", "", src.name));
      src.list = el("ul", "services");
      src.list.appendChild(row("Server", "unknown", "Checking"));
      panel.appendChild(src.list);
      box.appendChild(panel);
    });
  }

  function sortServices(list) {
    return list.slice().sort(function (a, b) {
      var ia = ORDER.indexOf(a.id), ib = ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }

  // renderSource draws one server's answer and returns its state:
  // ok, degraded, down, or unreachable.
  function renderSource(src, result, now) {
    var ul = src.list;
    ul.textContent = "";
    if (!result.data) {
      ul.appendChild(row("Server", "down", result.why));
      (src.lastIds || []).forEach(function (id) {
        ul.appendChild(row(label(id), "unknown", ""));
      });
      return "unreachable";
    }
    var data = result.data;
    var lag = Math.max(0, (now - Date.parse(data.checked_at)) / 1000);
    ul.appendChild(row("Server", "ok", "Answering"));
    var services = sortServices(data.services);
    src.lastIds = services.map(function (s) { return s.id; });
    src.bad = [];
    services.forEach(function (s) {
      var state = STATE_WORDS[s.state] ? s.state : "unknown";
      var note;
      if (typeof s.age !== "number") note = "No sign of work yet";
      else if (state === "ok") note = "Updated " + ago(s.age + lag);
      else note = "Last working " + ago(s.age + lag);
      ul.appendChild(row(label(s.id), state, note));
      if (state !== "ok") src.bad.push(label(s.id));
    });
    return RANK[data.state] != null ? data.state : "degraded";
  }

  function renderBanner(states) {
    var unreachable = [], down = [], degraded = [];
    sources.forEach(function (src, i) {
      if (states[i] === "unreachable") unreachable.push(src.name);
      else if (states[i] === "down") down.push(src.name + ": " + src.bad.join(", "));
      else if (states[i] === "degraded") degraded.push(src.name + ": " + src.bad.join(", "));
    });
    if (unreachable.length === sources.length) {
      setBanner("down", (sources.length === 1 ? sources[0].name : "EveSynapse") + " is unreachable",
        "No server is answering. Service states are unknown until one does.");
    } else if (unreachable.length) {
      setBanner("down", unreachable.join(" and ") + (unreachable.length === 1 ? " is" : " are") + " unreachable",
        "Its service states are unknown until it answers again." + (down.length + degraded.length ? " Also: " + down.concat(degraded).join(". ") + "." : ""));
    } else if (down.length) {
      setBanner("down", "Some services are down", down.concat(degraded).join(". ") + ". The site may be missing data until they recover.");
    } else if (degraded.length) {
      setBanner("degraded", "Some services are slow", degraded.join(". ") + ". Data may be a little behind.");
    } else {
      setBanner("ok", "All services working", "Everything EveSynapse runs on is answering normally.");
    }
  }

  // History: one tick per check, the worst state of that check, kept
  // in this browser only.
  function readHistory() {
    try {
      var h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(h) ? h : [];
    } catch (e) {
      return [];
    }
  }

  function addHistory(state, now) {
    history.push({ t: now, s: state });
    if (history.length > HISTORY_MAX) history = history.slice(history.length - HISTORY_MAX);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) { /* storage off: the strip shows this visit only */ }
    renderHistory();
  }

  function renderHistory() {
    var box = $("history");
    box.textContent = "";
    history.forEach(function (e) {
      var bar = el("span", "tick");
      bar.setAttribute("data-state", e.s);
      bar.title = clock(new Date(e.t)) + ": " + (e.s === "unreachable" ? "Unreachable" : (STATE_WORDS[e.s] || e.s));
      box.appendChild(bar);
    });
    var bad = history.filter(function (e) { return e.s !== "ok"; }).length;
    box.setAttribute("aria-label", history.length + " recent checks, " + bad + " with a problem");
    if (history.length) {
      $("history-note").textContent = "Last " + history.length + " checks from this browser, oldest first.";
    }
  }

  // fetchSource resolves to {data} for a usable answer, {limited}
  // when the server asked us to slow down, or {why} otherwise.
  function fetchSource(src) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var kill = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    return fetch(src.url + "/status.json", {
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (res.status === 429) return { limited: true };
      if (!res.ok) return { why: "Answered with an error" };
      return res.json().then(function (data) {
        var checked = Date.parse(data && data.checked_at);
        if (!data || !Array.isArray(data.services) || isNaN(checked)) return { why: "Answered with something unreadable" };
        if (Date.now() - checked > STALE_MS) return { why: "Answered with an out of date status" };
        return { data: data };
      });
    }).catch(function () {
      return { why: "Not answering" };
    }).then(function (r) {
      clearTimeout(kill);
      return r;
    });
  }

  function check() {
    clearTimeout(timer);
    timer = setTimeout(check, POLL_MS);
    lastAttempt = Date.now();
    if (!sources.length) {
      setBanner("down", "Nothing to check", "No servers are listed in config.js.");
      return;
    }
    Promise.all(sources.map(fetchSource)).then(function (results) {
      var now = Date.now();
      if (results.some(function (r) { return r.limited; })) {
        $("last-check").textContent = "Too many checks from this address. Trying again in a minute.";
        return;
      }
      $("last-check").textContent = "Last check " + clock(new Date(now)) + ".";
      var states = sources.map(function (src, i) { return renderSource(src, results[i], now); });
      renderBanner(states);
      addHistory(states.reduce(function (a, b) { return RANK[b] > RANK[a] ? b : a; }, "ok"), now);
    });
  }

  function start() {
    if (sources.length) $("app-link").href = sources[0].url;
    buildPanels();
    history = readHistory().filter(function (e) {
      return e && typeof e.t === "number" && RANK[e.s] != null;
    }).slice(-HISTORY_MAX);
    renderHistory();
    check();
    // A hidden tab's timers slow down; catch up when it is shown.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && Date.now() - lastAttempt >= POLL_MS) check();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
