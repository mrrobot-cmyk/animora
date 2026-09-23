// Animora im Browser-App-Modus: startet über das signierte node.exe und dient
// die vorhandene Oberfläche + Backend-Logik ohne Electron und ohne mpv aus.
// Wiedergabe läuft per hls.js/<video> im Browser; ein Proxy setzt die von den
// Quellen verlangten HTTP-Header (Referer/Origin/User-Agent).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "app");
const WEB_DIR = path.join(ROOT, "web");
const { createStore, libraryKey } = require(path.join(APP_DIR, "lib", "store.cjs"));
const { createCatalogue, friendlyError } = require(path.join(APP_DIR, "lib", "catalogue.cjs"));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const USER_DATA = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Roaming"), "Animora");
const LOG_DIR = path.join(USER_DATA, "logs");
// Fester Port, damit Einstellungen des App-Fensters (Origin) erhalten bleiben.
const BASE_PORT = Number(process.env.PORT) || 8620;
const HOST = "127.0.0.1";
// Ohne Lebenszeichen vom Fenster beendet sich der Server (Fenster geschlossen).
const IDLE_EXIT_MS = 30000;
const STARTUP_GRACE_MS = 120000;

function log(message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, "web.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.rmSync(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

const env = { ...process.env, NODE_USE_SYSTEM_CA: "1" };
const store = createStore(path.join(USER_DATA, "library.json"));
const catalogue = createCatalogue({ root: ROOT, env, cacheDir: path.join(USER_DATA, "cache"), log });

// ---------- Stream-Auflösung (wie src/play.mjs, aber Ausgabe für den Browser) ----------

function pickSubtitle(data) {
  if (!Array.isArray(data.subtitles)) return null;
  const english = data.subtitles.find((s) => {
    const text = `${s.label ?? ""} ${s.language ?? ""}`;
    return /\benglish\b/i.test(text) || /^(en|eng)([-_]|$)/i.test(String(s.language ?? s.lang ?? ""));
  });
  return english?.url || english?.file || data.subtitles[0]?.url || data.subtitles[0]?.file || null;
}

function resolveStream(moduleName, episodeUrl, lang) {
  const cli = path.join(ROOT, "src", "cli.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--use-system-ca", cli, "stream", moduleName, episodeUrl, lang], {
      cwd: ROOT, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Zeitüberschreitung beim Auflösen des Streams.")); }, 90000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(friendlyError(stderr || stdout, "Wiedergabe konnte nicht gestartet werden.")));
      try {
        const start = stdout.indexOf("{"), end = stdout.lastIndexOf("}");
        resolve(JSON.parse(stdout.slice(start, end + 1)));
      } catch (e) { reject(new Error("Die Stream-Antwort war ungültig.")); }
    });
  });
}

// Baut aus der Modulantwort eine im Browser abspielbare, proxierte URL.
function toPlayback(data) {
  const streams = Array.isArray(data.streams) && data.streams.length ? data.streams : (data.url ? [data] : []);
  if (!streams.length) return null;
  const stream = streams.find((s) => s.streamType === "hls" || s.kind === "hls") || streams[0];
  const url = stream.url || stream.file;
  if (!url) return null;
  const headers = stream.headers || data.headers || {};
  const streamType = stream.streamType || stream.kind || (/\.m3u8(?:[?#]|$)/i.test(url) ? "hls" : "mp4");
  const subtitle = pickSubtitle(data);
  return {
    url: proxied(url, headers),
    streamType,
    subtitle: subtitle ? proxied(subtitle, headers) : null,
    subtitles: Array.isArray(data.subtitles) ? data.subtitles.map((s) => ({
      label: s.label || s.language || "Untertitel",
      language: s.language || s.lang || "",
      url: proxied(s.url || s.file, headers),
    })).filter((s) => s.url) : [],
  };
}

// ---------- HLS/Medien-Proxy (setzt die von der Quelle verlangten Header) ----------

function proxied(url, headers) {
  const h = Buffer.from(JSON.stringify(headers || {})).toString("base64url");
  return `/api/stream?u=${Buffer.from(String(url)).toString("base64url")}&h=${h}`;
}

function decodeProxyParams(query) {
  try {
    return {
      url: Buffer.from(query.get("u") || "", "base64url").toString("utf8"),
      headers: JSON.parse(Buffer.from(query.get("h") || "", "base64url").toString("utf8") || "{}"),
    };
  } catch { return null; }
}

// Segment-/Schlüssel-/Untertitel-URLs im Playlist-Text auf den eigenen Proxy
// umbiegen, damit auch sie mit den richtigen Headern geladen werden.
function rewritePlaylist(text, baseUrl, headers) {
  const abs = (ref) => { try { return new URL(ref, baseUrl).href; } catch { return ref; } };
  return text.split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (line[0] === "#") {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxied(abs(uri), headers)}"`);
    }
    return proxied(abs(line.trim()), headers);
  }).join("\n");
}

async function handleStream(req, res, query) {
  const target = decodeProxyParams(query);
  if (!target || !/^https?:\/\//i.test(target.url)) { res.writeHead(400).end("bad target"); return; }
  const reqHeaders = { ...target.headers };
  if (req.headers.range) reqHeaders.Range = req.headers.range;
  let upstream;
  try {
    upstream = await fetch(target.url, { headers: reqHeaders, redirect: "follow" });
  } catch (e) { log(`proxy fehlgeschlagen ${target.url}: ${e.message}`); res.writeHead(502).end("upstream error"); return; }

  if (!upstream.body) { res.writeHead(upstream.status).end(); return; }
  const reader = upstream.body.getReader();
  const first = await reader.read();
  const head = first.value ? Buffer.from(first.value) : Buffer.alloc(0);

  // Playlists am Inhalt erkennen (viele Quellen liefern m3u8 ohne .m3u8-Endung
  // und ohne mpegurl-Content-Type). Dann Segment-URLs auf den Proxy umbiegen.
  if (head.slice(0, 7).toString("latin1") === "#EXTM3U") {
    const chunks = [head];
    for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(Buffer.from(r.value)); }
    const body = rewritePlaylist(Buffer.concat(chunks).toString("utf8"), upstream.url || target.url, target.headers);
    res.writeHead(upstream.status, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
    res.end(body);
    return;
  }

  const headers = { "cache-control": "no-store" };
  for (const key of ["content-type", "content-length", "accept-ranges", "content-range"]) {
    const value = upstream.headers.get(key);
    if (value) headers[key] = value;
  }
  res.writeHead(upstream.status, headers);
  try {
    if (head.length && !res.write(head)) await new Promise((r) => res.once("drain", r));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
    }
  } catch {} finally { res.end(); }
}

// ---------- statische Dateien ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" };

// index.html der Electron-App, aber mit browsertauglicher CSP und Shim/hls.js.
function buildIndexHtml() {
  let html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
  const csp = "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'";
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  html = html.replace("</head>", '    <link rel="icon" href="assets/icon.png" />\n    <link rel="stylesheet" href="web-player.css" />\n  </head>');
  html = html.replace('<script src="js/core.js"></script>', '<script src="hls.min.js"></script>\n    <script src="web-shim.js"></script>\n    <script src="js/core.js"></script>');
  return html;
}

function serveStatic(req, res, urlPath) {
  if (urlPath === "/" || urlPath === "/index.html") {
    const body = buildIndexHtml();
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(body);
    return;
  }
  const rel = decodeURIComponent(urlPath.replace(/^\/+/, ""));
  // web/ liefert Shim + hls.js, sonst app/ (js, css, assets).
  const roots = /^(web-shim\.js|hls\.min\.js|web-player\.css)$/.test(rel) ? [WEB_DIR] : [APP_DIR];
  for (const base of roots) {
    const file = path.join(base, rel);
    if (!file.startsWith(base)) break; // kein Ausbruch aus dem Ordner
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }
  res.writeHead(404).end("not found");
}

// ---------- API ----------

const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => { data += c; });
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
});

async function handleApi(req, res, urlPath, query) {
  const send = (value, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value ?? null)); };
  const fail = (error) => send({ error: String(error?.message || error) }, 400);
  try {
    if (req.method === "GET") {
      switch (urlPath) {
        case "/api/info": return send({ app: "animora", version: VERSION, web: true, dataDir: USER_DATA, logDir: LOG_DIR });
        case "/api/modules": return send(catalogue.listModules());
        case "/api/library": return send(store.snapshot());
        case "/api/discovery": return send(await catalogue.discovery(query.get("module"), { force: query.get("force") === "1" }));
        case "/api/cachedDiscovery": return send(catalogue.cachedDiscovery(query.get("module")));
        case "/api/feed": return send(await catalogue.feed(query.get("module"), query.get("feedId"), query.get("page")));
        case "/api/search": {
          if (query.get("remember") !== "0") store.addRecentSearch(query.get("q") || "");
          return send(await catalogue.search(query.get("module"), query.get("q") || ""));
        }
        case "/api/details": return send(await catalogue.details(query.get("module"), query.get("href")));
        case "/api/episodes": return send(await catalogue.episodes(query.get("module"), query.get("href")));
      }
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      switch (urlPath) {
        case "/api/ping": lastPing = Date.now(); return send(true);
        case "/api/openLogs": {
          fs.mkdirSync(LOG_DIR, { recursive: true });
          spawn("explorer.exe", [LOG_DIR], { detached: true, stdio: "ignore" }).unref();
          return send(true);
        }
        case "/api/library/toggleFavorite": return send(store.toggleFavorite(body));
        case "/api/library/removeHistory": return send(store.removeHistory(body.key) ?? true);
        case "/api/library/clearHistory": return send(store.clearHistory() ?? true);
        case "/api/library/clearRecentSearches": return send(store.clearRecentSearches() ?? true);
        case "/api/library/setSettings": return send(store.setSettings(body));
        case "/api/clearCache": return send(catalogue.clear() ?? true);
        case "/api/player/resolve": {
          const data = await resolveStream(body.moduleName, body.episode.href, body.language);
          const playback = toPlayback(data);
          if (!playback) return fail("Für diese Episode wurde in der gewählten Sprache kein Stream gefunden. Versuche die andere Sprache oder eine andere Quelle.");
          store.recordPlay({
            show: { moduleName: body.moduleName, href: body.show.href, title: body.show.title, image: body.show.image },
            episode: body.episode, language: body.language,
          });
          return send(playback);
        }
        case "/api/player/progress": {
          store.recordProgress(libraryKey(body.moduleName, body.href), body.episodeNumber, {
            position: body.position, duration: body.duration, language: body.language,
          });
          return send(true);
        }
      }
    }
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
  } catch (error) { fail(error); }
}

// ---------- Server ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;
  if (p === "/api/stream") return handleStream(req, res, url.searchParams);
  if (p.startsWith("/api/")) return handleApi(req, res, p, url.searchParams);
  serveStatic(req, res, p);
});

process.on("exit", () => { try { store.flush(); } catch {} });
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// Chromium-Browser im App-Modus öffnen: eigenes Fenster ohne Tabs/Adressleiste.
// Die Browser sind signiert, daher blockiert Smart App Control hier nichts.
// Reihenfolge = Vorrang. Pfade relativ zu Programme, Programme (x86), LocalAppData.
const CHROMIUM_BROWSERS = [
  ["Microsoft", "Edge", "Application", "msedge.exe"],
  ["Google", "Chrome", "Application", "chrome.exe"],
  ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
  ["Vivaldi", "Application", "vivaldi.exe"],
  ["Chromium", "Application", "chrome.exe"],
];

function findBrowser() {
  const bases = [
    process.env.ProgramFiles || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  for (const parts of CHROMIUM_BROWSERS) {
    for (const base of bases) {
      const file = path.join(base, ...parts);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

function openWindow(address) {
  const browser = findBrowser();
  if (browser) {
    const child = spawn(browser, [
      `--app=${address}`,
      `--user-data-dir=${path.join(USER_DATA, "browser")}`,
      "--no-first-run", "--no-default-browser-check",
    ], { detached: true, stdio: "ignore" });
    child.on("error", () => openInDefaultBrowser(address));
    child.unref();
    log(`App-Fenster über ${browser}`);
    return;
  }
  // Kein Chromium-Browser: normal im Standardbrowser öffnen (z. B. Firefox).
  openInDefaultBrowser(address);
}

function openInDefaultBrowser(address) {
  console.log(`Öffne im Standardbrowser: ${address}`);
  log("Kein Chromium-Browser gefunden – öffne im Standardbrowser");
  spawn("explorer.exe", [address], { detached: true, stdio: "ignore" }).unref();
}

// Das Fenster meldet sich alle paar Sekunden (/api/ping). Bleibt das aus, ist
// es geschlossen und der Server beendet sich. Robuster als auf den
// Browser-Prozess zu warten: der gibt bei laufendem Edge sofort ab.
let lastPing = 0;
const startedAt = Date.now();
setInterval(() => {
  const idle = lastPing ? Date.now() - lastPing > IDLE_EXIT_MS : Date.now() - startedAt > STARTUP_GRACE_MS;
  if (idle && process.env.ANIMORA_NO_OPEN !== "1") {
    log("Kein Fenster mehr offen – beende");
    process.exit(0);
  }
}, 5000).unref();

// Läuft auf dem Port schon Animora (zweiter Doppelklick)? Dann nur ein weiteres
// Fenster öffnen. Ist der Port anderweitig belegt, den nächsten versuchen.
async function isAnimora(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/info`, { signal: AbortSignal.timeout(1500) });
    return (await res.json())?.app === "animora";
  } catch { return false; }
}

function listen(port, attempt = 0) {
  server.once("error", async (error) => {
    if (error.code !== "EADDRINUSE" || attempt >= 10) {
      console.error(`Animora konnte nicht starten: ${error.message}`);
      log(`Start fehlgeschlagen: ${error.message}`);
      process.exit(1);
    }
    if (await isAnimora(port)) {
      console.log("Animora läuft bereits – öffne Fenster.");
      openWindow(`http://${HOST}:${port}/`);
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    listen(port + 1, attempt + 1);
  });
  server.listen(port, HOST, () => {
    const address = `http://${HOST}:${port}/`;
    log(`Web-Server ${VERSION} gestartet auf ${address} pid=${process.pid}`);
    console.log(`Animora ${VERSION} läuft: ${address}`);
    if (process.env.ANIMORA_NO_OPEN !== "1") {
      console.log("Das App-Fenster wird geöffnet. Schließen des Fensters beendet Animora.");
      openWindow(address);
    }
  });
}

listen(BASE_PORT);
