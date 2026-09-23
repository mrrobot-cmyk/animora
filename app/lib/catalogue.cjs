// Access to the Contract-V4 modules through the existing src/cli.mjs harness,
// with an in-memory cache and a small disk cache for the home page.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TTL = {
  search: 10 * 60 * 1000,
  details: 30 * 60 * 1000,
  episodes: 10 * 60 * 1000,
  discovery: 10 * 60 * 1000,
  feed: 10 * 60 * 1000,
};
const CLI_TIMEOUT_MS = 90000;

// Feeds a module's discoveryFeed() supports without advertising them in
// discoveryHome() (taken from the module source).
const EXTRA_FEEDS = {
  AnimeKai: [
    { id: "tv", title: "TV-Serien" },
    { id: "movies", title: "Filme" },
  ],
};

function friendlyError(output, fallback) {
  const text = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "FEHLER:" && !line.startsWith("[module]") && !line.startsWith("at ") && !line.startsWith("Loaded:") && !line.startsWith("HOSTSTATS"))
    .map((line) => line.replace(/^ERROR:\s*/, "").replace(/^[A-Za-z]*Error:\s*/, ""))
    .join("\n");

  if (/mpv\.exe wurde nicht gefunden/.test(text)) return "mpv wurde nicht gefunden.";
  if (/mpv konnte nicht gestartet werden/.test(text)) return "mpv konnte nicht gestartet werden.";
  if (/keinen Stream zurückgegeben|unable to resolve playable stream|stream unavailable|stream candidates were empty/i.test(text)) {
    return "Für diese Episode wurde in der gewählten Sprache kein Stream gefunden. Versuche die andere Sprache, wähle oben rechts eine andere Quelle oder versuche es später erneut.";
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(text)) {
    return "Die Quelle ist nicht erreichbar. Bitte Internetverbindung prüfen und erneut versuchen.";
  }
  if (/certificate|CERT_/i.test(text)) return "Die sichere Verbindung zur Quelle konnte nicht geprüft werden.";
  if (/HTTP (4|5)\d\d/.test(text)) return "Die Quelle hat die Anfrage abgelehnt oder ist gestört. Bitte später erneut versuchen.";
  return fallback;
}

function extractJson(output) {
  // Module log lines ("[module] …") share stdout with the JSON dump, so try
  // each line that starts a JSON value until the rest of the output parses.
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const first = lines[index].trimStart()[0];
    if (first !== "[" && first !== "{") continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {}
  }
  throw new Error("Die Modulantwort enthält kein gültiges JSON.");
}

// An answer without any content. Modules return this both for "nothing found"
// and when their requests failed, so it is never cached.
function isEmptyResult(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== "object") return true;
  if (Array.isArray(value.sections)) return !value.sections.some((s) => Array.isArray(s.items) && s.items.length);
  if (Array.isArray(value.items)) return value.items.length === 0;
  if ("title" in value || "description" in value) return !value.title && !value.description;
  return false;
}

function parseStats(stderr) {
  const match = String(stderr || "").match(/^HOSTSTATS (.+)$/m);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

// Empty answer while requests to the source failed: the source is down,
// blocking or rate limiting – not "no results". 404 is a normal miss.
function sourceProblem(value, stats) {
  if (!stats || !isEmptyResult(value)) return "";
  const failures = (stats.failures || []).filter((f) => f.status === 0 || f.status === 403 || f.status === 429 || f.status >= 500);
  if (!failures.length) return "";
  const codes = [...new Set(failures.map((f) => (f.status ? `HTTP ${f.status}` : f.reason === "timeout" ? "Zeitüberschreitung" : "keine Verbindung")))].join(", ");
  return `Die Quelle antwortet gerade nicht richtig (${codes}). Bitte gleich erneut versuchen oder oben rechts eine andere Quelle wählen.`;
}

function createCatalogue({ root, env, cacheDir, log }) {
  const cli = path.join(root, "src", "cli.mjs");
  const modulesDir = path.join(root, "modules");
  const memory = new Map();
  const inflight = new Map();
  let modules = null;

  function listModules() {
    if (modules) return modules;
    modules = fs.readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(modulesDir, entry.name, "module.json"), "utf8"));
          const presentation = manifest.presentation || manifest.config?.presentation || {};
          const name = manifest.name || entry.name;
          return [{
            name,
            version: manifest.moduleVersion || "",
            language: presentation.language || "",
            languages: Array.isArray(presentation.languages) ? presentation.languages : [],
            extraFeeds: EXTRA_FEEDS[name] || [],
          }];
        } catch (error) {
          log(`Modul ${entry.name} konnte nicht gelesen werden: ${error.message}`);
          return [];
        }
      });
    return modules;
  }

  function assertModule(moduleName) {
    if (!listModules().some((m) => m.name === moduleName)) throw new Error(`Unbekanntes Modul: ${moduleName}`);
  }

  function runCli(args, fallbackMessage) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--use-system-ca", cli, ...args], {
        cwd: root,
        windowsHide: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const fail = (message, detail) => {
        log(`cli ${args.slice(0, 2).join(" ")} fehlgeschlagen: ${detail || message}`);
        reject(new Error(message));
      };
      const timer = setTimeout(() => {
        child.kill();
        fail("Zeitüberschreitung: Die Quelle hat nicht rechtzeitig geantwortet.", "timeout");
      }, CLI_TIMEOUT_MS);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        clearTimeout(timer);
        fail(fallbackMessage, error.message);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return fail(friendlyError(stderr || stdout, fallbackMessage), (stderr || stdout).slice(-2000));
        let value;
        try {
          value = extractJson(stdout);
        } catch (error) {
          return fail(fallbackMessage, `${error.message}\n${stdout.slice(-2000)}`);
        }
        const stats = parseStats(stderr);
        const problem = sourceProblem(value, stats);
        if (problem) return fail(problem, `leeres Ergebnis, fehlgeschlagene Anfragen: ${JSON.stringify(stats.failures)}`);
        resolve(value);
      });
    });
  }

  function cached(kind, key, loader, { force = false } = {}) {
    const id = `${kind}|${key}`;
    const hit = memory.get(id);
    if (!force && hit && Date.now() - hit.at < TTL[kind]) return Promise.resolve(hit.value);
    if (inflight.has(id)) return inflight.get(id);
    const promise = loader()
      .then((value) => {
        // Empty answers are not cached: a short outage must not stick for minutes.
        if (!isEmptyResult(value)) memory.set(id, { at: Date.now(), value });
        else memory.delete(id);
        return value;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, promise);
    return promise;
  }

  function discoveryFile(moduleName) {
    return path.join(cacheDir, `discovery-${moduleName.replace(/[^a-z0-9_-]/gi, "_")}.json`);
  }

  return {
    listModules,

    search(moduleName, query) {
      assertModule(moduleName);
      const q = String(query || "").trim();
      return cached("search", `${moduleName}|${q.toLowerCase()}`, () =>
        runCli(["search", moduleName, q], "Die Suche konnte nicht ausgeführt werden."));
    },

    details(moduleName, href) {
      assertModule(moduleName);
      return cached("details", `${moduleName}|${href}`, () =>
        runCli(["details", moduleName, href], "Anime konnte nicht geladen werden."));
    },

    episodes(moduleName, href) {
      assertModule(moduleName);
      return cached("episodes", `${moduleName}|${href}`, () =>
        runCli(["episodes", moduleName, href], "Episoden konnten nicht geladen werden."));
    },

    discovery(moduleName, options = {}) {
      assertModule(moduleName);
      return cached("discovery", moduleName, async () => {
        const value = await runCli(["discovery", moduleName], "Die Startseite konnte nicht geladen werden.");
        if (!isEmptyResult(value)) {
          try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(discoveryFile(moduleName), JSON.stringify({ at: Date.now(), value }));
          } catch {}
        }
        return value;
      }, options);
    },

    cachedDiscovery(moduleName) {
      try {
        const saved = JSON.parse(fs.readFileSync(discoveryFile(moduleName), "utf8"));
        return saved && saved.value ? { cachedAt: saved.at, ...saved.value } : null;
      } catch {
        return null;
      }
    },

    feed(moduleName, feedId, page) {
      assertModule(moduleName);
      const pageNumber = Math.max(1, Number(page) || 1);
      return cached("feed", `${moduleName}|${feedId}|${pageNumber}`, () =>
        runCli(["discovery", moduleName, String(feedId), String(pageNumber)], "Diese Liste konnte nicht geladen werden."));
    },

    clear() {
      memory.clear();
      try {
        for (const file of fs.readdirSync(cacheDir)) {
          if (file.startsWith("discovery-")) fs.rmSync(path.join(cacheDir, file), { force: true });
        }
      } catch {}
    },
  };
}

module.exports = { createCatalogue, friendlyError };
