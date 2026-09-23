import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function findMpv() {
  const candidates = [
    process.env.MPV_PATH,
    resolve(ROOT, "mpv", "mpv.exe"),
    resolve(ROOT, "mpv.exe"),
    "C:\\Program Files\\mpv\\mpv.exe",
    "C:\\Program Files (x86)\\mpv\\mpv.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }

  return null;
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Keine gültige JSON-Antwort vom V4-Host erhalten.");
  }

  return JSON.parse(text.slice(start, end + 1));
}

function getHeaderArgs(headers = {}) {
  const args = [];

  for (const [name, value] of Object.entries(headers)) {
    if (value == null || value === "") continue;

    const lowerName = String(name).toLowerCase();

    // Use mpv's dedicated options for these common headers. Repeated
    // --http-header-fields assignments replace earlier list entries, which
    // can silently drop the Referer/Origin required by an HLS host.
    if (lowerName === "user-agent") {
      args.push(`--user-agent=${value}`);
    } else if (lowerName === "referer" || lowerName === "referrer") {
      args.push(`--referrer=${value}`);
    } else {
      args.push(`--http-header-fields-add=${name}: ${value}`);
    }
  }

  return args;
}

function getSubtitleUrl(data) {
  if (!Array.isArray(data.subtitles)) return null;

  // Match "English" or an "en"/"eng" language code only; a plain substring
  // test for "en" also matched e.g. "French" or "Armenian".
  const english = data.subtitles.find((s) => {
    const text = `${s.label ?? ""} ${s.language ?? ""}`;
    return /\benglish\b/i.test(text) || /^(en|eng)([-_]|$)/i.test(String(s.language ?? s.lang ?? ""));
  });

  return english?.url || english?.file || data.subtitles[0]?.url || data.subtitles[0]?.file || null;
}

async function resolveStream(moduleName, episodeUrl, lang) {
  const cli = resolve(ROOT, "src", "cli.mjs");
  const [nodeMajor, nodeMinor] = process.versions.node
    .split(".")
    .map((part) => Number(part));
  const supportsSystemCa =
    nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 15);

  const args = [
    // On Windows, recent Node versions can use the OS certificate store.
    // This fixes TLS verification for the locally installed corporate/root CA
    // without disabling certificate validation.
    ...(process.platform === "win32" && supportsSystemCa ? ["--use-system-ca"] : []),
    cli,
    "stream",
    moduleName,
    episodeUrl,
    lang,
  ];

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Stream-Auflösung fehlgeschlagen (Exit ${code}).\n${stderr || stdout}`
          )
        );
        return;
      }

      try {
        resolvePromise(parseJson(stdout));
      } catch (error) {
        reject(
          new Error(
            `${error.message}\n\nHost-Ausgabe:\n${stdout}\n${stderr}`
          )
        );
      }
    });
  });
}

// Additional mpv options from the desktop app (IPC pipe for progress, start
// position, window title, ...), passed as a JSON array of "--option" strings.
function extraMpvArgs() {
  try {
    const extra = JSON.parse(process.env.SYNTHETIQ_MPV_ARGS || "[]");
    return Array.isArray(extra)
      ? extra.filter((arg) => typeof arg === "string" && arg.startsWith("--"))
      : [];
  } catch {
    return [];
  }
}

function startMpv(mpv, stream, subtitle) {
  const url = stream.url;

  if (!url) {
    throw new Error("Die Stream-Antwort enthält keine URL.");
  }

  const args = [
    "--force-window=yes",
    "--keep-open=yes",
    "--title=Synthetiq",
    "--cache=yes",
    "--demuxer-max-bytes=150MiB",
    "--demuxer-max-back-bytes=50MiB",
    ...getHeaderArgs(stream.headers),
  ];

  if (subtitle) {
    args.push(`--sub-file=${subtitle}`);
  }

  args.push(...extraMpvArgs());
  args.push(url);

  console.log("");
  console.log("Starte mpv...");
  console.log(`Stream: ${stream.label || "HLS"}`);
  console.log(
    `HTTP-Header: ${Object.keys(stream.headers || {}).join(", ") || "keine"}`
  );

  const player = spawn(mpv, args, {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: false,
  });

  player.on("error", (error) => {
    console.error("");
    console.error("mpv konnte nicht gestartet werden:");
    console.error(error.message);
    process.exitCode = 1;
  });

  player.on("close", (code) => {
    process.exitCode = code ?? 0;
  });
}

async function main() {
  const [
    moduleName,
    episodeUrl,
    lang = "sub",
  ] = process.argv.slice(2);

  if (!moduleName || !episodeUrl) {
    console.log(`
Synthetiq V4 Windows Player

Verwendung:
  node src\\play.mjs <Modul> "<Episoden-URL>" [sub|dub]

Beispiel:
  node src\\play.mjs AnimeKai "https://animekai.be/watch/one-piece/ep-1155" sub
`);
    process.exitCode = 1;
    return;
  }

  const mpv = findMpv();

  if (!mpv) {
    console.error(`
mpv.exe wurde nicht gefunden.

Installiere mpv oder lege mpv.exe hier ab:

  ${resolve(ROOT, "mpv", "mpv.exe")}

Alternativ:
  set MPV_PATH=C:\\Pfad\\zu\\mpv.exe
`);
    process.exitCode = 1;
    return;
  }

  console.log(`Modul:    ${moduleName}`);
  console.log(`Episode:  ${episodeUrl}`);
  console.log(`Sprache:  ${lang}`);
  console.log("");
  console.log("Löse Stream über Contract V4 auf...");

  const data = await resolveStream(moduleName, episodeUrl, lang);

  // Modules return either { streams: [...] } or a single flat stream object
  // ({ url, headers, streamType, subtitles }, e.g. Anikage).
  const streams =
    Array.isArray(data.streams) && data.streams.length > 0
      ? data.streams
      : data.url
        ? [data]
        : [];

  if (streams.length === 0) {
    throw new Error("Das Modul hat keinen Stream zurückgegeben.");
  }

  const stream =
    streams.find((s) => s.streamType === "hls") ||
    streams[0];

  const subtitle = getSubtitleUrl(data);

  console.log(`Stream:   ${stream.url}`);
  console.log(`Typ:      ${stream.streamType || "unknown"}`);

  if (subtitle) {
    console.log(`Sub:      ${subtitle}`);
  }

  startMpv(
    mpv,
    {
      ...stream,
      headers: stream.headers || data.headers || {},
    },
    subtitle
  );
}

main().catch((error) => {
  console.error("");
  console.error("FEHLER:");
  console.error(error.message);
  process.exitCode = 1;
});
