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
  // The daily maintenance window, minutes into the UTC day: the
  // servers patch and reboot inside it, so a main site that is
  // unreachable then is in the planned window, not an incident.
  var MAINT_START = 11 * 60;
  var MAINT_END = 12 * 60;
  // The Discord invite the site itself publishes.
  var DISCORD_URL = "https://discord.gg/76jpPP6Whb";

  var LABELS = {
    database: "Database",
    worker: "Background sync",
    notifications: "Notifications",
    esi: "EVE API (ESI)",
    market: "Market data",
    push: "Browser push",
    market_api: "Market API"
  };
  var ORDER = ["database", "worker", "esi", "market", "notifications", "push"];
  var STATE_WORDS = {
    ok: "Working",
    degraded: "Degraded",
    down: "Down",
    unknown: "Unknown"
  };
  var RANK = { ok: 0, degraded: 1, down: 2, unreachable: 3 };
  // What each kind of source answers, and where by default:
  // summary, an EveSynapse /status.json with a list of services;
  // single, one service's {service, state, checked_at} (the market
  // API's health); esi, ESI's own Tranquility status, read directly.
  var PATHS = {
    summary: "/status.json",
    single: "/api/market/v1/health",
    esi: "/latest/status/?datasource=tranquility"
  };

  var cfg = window.STATUS_CONFIG || {};
  var sources = (Array.isArray(cfg.sources) ? cfg.sources : []).filter(function (s) {
    return s && typeof s.url === "string" && s.url;
  }).map(function (s) {
    var kind = PATHS[s.kind] ? s.kind : "summary";
    return {
      name: String(s.name || s.url),
      kind: kind,
      base: s.url.replace(/\/+$/, ""),
      url: s.url.replace(/\/+$/, "") + (typeof s.path === "string" && s.path ? s.path : PATHS[kind]),
      bad: [],
      lastIds: null, // service ids of the last answer, for unknown rows
      list: null
    };
  });
  var lastAttempt = 0;
  var timer = 0;
  var history = [];
  var mainWasDown = false;

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
    if (detail != null) $("banner-detail").textContent = detail;
  }

  // setBannerDetail fills the banner's detail line from parts:
  // plain strings, and {text, href} for a link.
  function setBannerDetail(parts) {
    var d = $("banner-detail");
    d.textContent = "";
    parts.forEach(function (p) {
      if (typeof p === "string") { d.appendChild(document.createTextNode(p)); return; }
      var a = el("a", "", p.text);
      a.href = p.href;
      a.target = "_blank";
      a.rel = "noreferrer";
      d.appendChild(a);
    });
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
    var norm = result.data;
    ul.appendChild(row("Server", "ok", "Answering"));
    src.lastIds = norm.rows.map(function (r) { return r.id; });
    src.bad = [];
    norm.rows.forEach(function (r) {
      ul.appendChild(row(label(r.id), r.state, r.note));
      if (r.state !== "ok") src.bad.push(label(r.id));
    });
    return norm.state;
  }

  // normalize turns a source's answer into {state, rows}, one row
  // per service, or {why} when the answer cannot be used.
  function normalize(src, data, now) {
    if (!data || typeof data !== "object") return { why: "Answered with something unreadable" };
    if (src.kind === "esi") {
      if (typeof data.players !== "number") return { why: "Answered with something unreadable" };
      var vip = data.vip === true;
      return { data: { state: vip ? "degraded" : "ok", rows: [{
        id: "Tranquility",
        state: vip ? "degraded" : "ok",
        note: vip ? "VIP mode, developers only" : data.players.toLocaleString() + " players online"
      }] } };
    }
    var checked = Date.parse(data.checked_at);
    if (isNaN(checked)) return { why: "Answered with something unreadable" };
    if (now - checked > STALE_MS) return { why: "Answered with an out of date status" };
    var lag = Math.max(0, (now - checked) / 1000);
    if (src.kind === "single") {
      if (RANK[data.state] == null || data.state === "unreachable") return { why: "Answered with something unreadable" };
      return { data: { state: data.state, rows: [{
        id: String(data.service || "service"),
        state: data.state,
        note: "Checked " + ago(lag)
      }] } };
    }
    if (!Array.isArray(data.services)) return { why: "Answered with something unreadable" };
    var rows = sortServices(data.services).map(function (s) {
      var state = STATE_WORDS[s.state] ? s.state : "unknown";
      var note;
      if (typeof s.age !== "number") note = "No sign of work yet";
      else if (state === "ok") note = "Updated " + ago(s.age + lag);
      else note = "Last working " + ago(s.age + lag);
      return { id: String(s.id), state: state, note: note };
    });
    return { data: { state: RANK[data.state] != null ? data.state : "degraded", rows: rows } };
  }

  function inMaintWindow(now) {
    var d = new Date(now);
    var m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return m >= MAINT_START && m < MAINT_END;
  }

  function setNotice(text) {
    if (!text) { $("notice").hidden = true; return; }
    $("notice-text").textContent = text;
    $("notice").hidden = false;
  }

  // The notice carries the word about the main site (the first
  // summary source): the maintenance notice while it is
  // unreachable, the all-clear once it answers again after having
  // been down, and nothing otherwise.
  function renderNotice(states, now) {
    var main = -1;
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].kind === "summary") { main = i; break; }
    }
    if (main < 0) { setNotice(null); return; }
    if (states[main] === "unreachable") {
      mainWasDown = true;
      if (inMaintWindow(now)) {
        setNotice("EveSynapse is down for daily security patching and system and service maintenance. The daily window runs 11:00 to 12:00 UTC. This page checks every minute and will show when the site is back up.");
      } else {
        setNotice("EveSynapse is not answering. This page checks every minute and will show when the site is back up.");
      }
    } else if (mainWasDown) {
      mainWasDown = false;
      setNotice("EveSynapse is back up.");
    } else {
      setNotice(null);
    }
  }

  function renderBanner(states) {
    var main = -1;
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].kind === "summary") { main = i; break; }
    }
    // The two poles are the main site's own states, in the site's
    // words. Anything between them keeps the per-service account.
    if (main >= 0 && states[main] === "unreachable") {
      setBanner("down", "EveSynapse is unavailable", null);
      setBannerDetail(["Service is unreachable, please watch this page or check ",
        { text: "our discord", href: DISCORD_URL }, " for more updates."]);
      return;
    }
    if (states.length && states.every(function (s) { return s === "ok"; })) {
      setBanner("ok", "EveSynapse is working", "Service is fully functional.");
      return;
    }
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
        (unreachable.length === 1 ? "Its service states are unknown until it answers again." : "Their service states are unknown until they answer again.") +(down.length + degraded.length ? " Also: " + down.concat(degraded).join(". ") + "." : ""));
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
    return fetch(src.url, {
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (res.status === 429) return { limited: true };
      if (!res.ok) return { why: "Answered with an error" };
      return res.json().then(function (data) {
        return normalize(src, data, Date.now());
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
      renderNotice(states, now);
      addHistory(states.reduce(function (a, b) { return RANK[b] > RANK[a] ? b : a; }, "ok"), now);
    });
  }

  function start() {
    if (sources.length) $("app-link").href = sources[0].base;
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
