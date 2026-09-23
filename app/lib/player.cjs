// Starts playback through the existing src/play.mjs (resolver + mpv) and
// follows mpv over its JSON IPC pipe for reliable progress and state.
const { spawn, execFile } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const RESOLVE_TIMEOUT_MS = 90000;
// play.mjs stays alive while mpv is open. If it is still running this long
// after printing "Starte mpv...", mpv has started and did not fail right away.
const PLAYER_GRACE_MS = 2500;
const PROGRESS_SAVE_MS = 5000;
const IMAGE_CODECS = /\b(png|mjpeg|jpe?g|bmp|gif|webp)\b/i;
const IMAGE_PROBLEM = "Diese Quelle liefert keine abspielbaren Videodaten (Bilddaten statt Video). Bitte wähle oben rechts eine andere Quelle oder versuche es später erneut.";

function playbackProblem(output) {
  // mpv keeps its window open either way (--force-window/--keep-open), so
  // recognise streams without playable video and tell the user about it.
  if (
    /(?:Video|Image)\s+--vid=\d+\s+\((?:png|mjpeg|jpeg|bmp|gif|webp)\b/i.test(output) ||
    /treating it as fatal error|Failed to recognize file format|Errors when loading file/i.test(output)
  ) {
    return IMAGE_PROBLEM;
  }
  return "";
}

function openLog(logDir, header) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, "player.log");
    // mpv writes a status line several times per second: start over past 1 MB.
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const stream = fs.createWriteStream(file, { flags: size > 1024 * 1024 ? "w" : "a" });
    stream.write(`\n=== ${new Date().toISOString()} ${header}\n`);
    return { file, stream };
  } catch {
    return { file: null, stream: null };
  }
}

function killTree(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

function createPlayer({ root, mpvPath, env, logDir, friendlyError, log, emit, onPlay, onProgress }) {
  const playerScript = path.join(root, "src", "play.mjs");
  let current = null;
  let sequence = 0;

  function publicState(session, extra = {}) {
    return {
      id: session.id,
      key: session.show.key,
      title: session.show.title,
      image: session.show.image,
      episode: session.episode,
      language: session.language,
      state: session.state,
      position: session.position,
      duration: session.duration,
      message: session.message || "",
      ...extra,
    };
  }

  function setState(session, state, message = "") {
    session.state = state;
    if (message) session.message = message;
    emit("player:state", publicState(session));
  }

  // Progress is only recorded once mpv decodes real video; a stream that turns
  // out to be images must never create progress or a "watched" mark.
  function saveProgress(session, force = false) {
    if (!session.videoOk || session.message || !(session.position > 0)) return;
    const now = Date.now();
    if (!force && now - session.lastSave < PROGRESS_SAVE_MS) return;
    session.lastSave = now;
    onProgress(session.show.key, session.episode.number, {
      position: session.position,
      duration: session.duration,
      language: session.language,
    });
  }

  function handleCodec(session, codec) {
    if (typeof codec !== "string" || !codec) return;
    if (IMAGE_CODECS.test(codec)) {
      if (!session.message) setState(session, "problem", IMAGE_PROBLEM);
    } else {
      session.videoOk = true;
    }
  }

  function connectIpc(session) {
    let attempts = 0;
    const tryConnect = () => {
      if (session.closed || session.socket) return;
      const socket = net.connect(session.pipe);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        session.socket = socket;
        const properties = ["time-pos", "duration", "eof-reached", "video-codec", "current-tracks/video/codec"];
        properties.forEach((name, index) => {
          socket.write(`${JSON.stringify({ command: ["observe_property", index + 1, name] })}\n`);
        });
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.event !== "property-change") continue;
          if (message.name === "video-codec" || message.name === "current-tracks/video/codec") {
            handleCodec(session, message.data);
          } else if (message.name === "duration" && typeof message.data === "number") {
            session.duration = message.data;
          } else if (message.name === "time-pos" && typeof message.data === "number") {
            session.position = message.data;
            if (!session.videoOk || session.message) continue;
            if (session.state !== "playing" && message.data > 0) setState(session, "playing");
            const now = Date.now();
            if (now - session.lastEmit > 1000) {
              session.lastEmit = now;
              emit("player:state", publicState(session));
            }
            saveProgress(session);
          } else if (message.name === "eof-reached" && message.data === true && session.videoOk && !session.message && session.duration > 0) {
            session.position = session.duration;
            saveProgress(session, true);
            setState(session, "ended");
          }
        }
      });
      socket.on("error", () => {
        socket.destroy();
        if (!session.socket && !session.closed && attempts++ < 80) setTimeout(tryConnect, 250);
      });
    };
    tryConnect();
  }

  async function stop() {
    const session = current;
    if (!session || session.closed) return;
    session.stopRequested = true;
    const closed = new Promise((resolve) => session.child.once("close", resolve));
    if (!session.socket) {
      // Still resolving (or no IPC yet): nothing to quit gracefully.
      await killTree(session.child.pid);
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1500))]);
      return;
    }
    // Graceful quit lets mpv report the final position first.
    session.socket.write(`${JSON.stringify({ command: ["quit"] })}\n`);
    const timedOut = await Promise.race([closed.then(() => false), new Promise((r) => setTimeout(() => r(true), 2500))]);
    if (timedOut && !session.closed) {
      await killTree(session.child.pid);
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1500))]);
    }
  }

  async function start({ moduleName, show, episode, language, resumeAt = 0, settings = {} }) {
    if (language !== "sub" && language !== "dub") throw new Error("Unbekannte Sprache.");
    await stop();

    const id = ++sequence;
    const session = {
      id, show, episode, language,
      pipe: `\\\\.\\pipe\\synthetiq-mpv-${process.pid}-${id}`,
      state: "resolving", position: 0, duration: 0, lastSave: 0, lastEmit: 0,
      socket: null, closed: false, stopRequested: false, message: "", videoOk: false,
    };
    current = session;
    setState(session, "resolving");

    const mediaTitle = `${show.title || "Animora"} – Episode ${episode.number}`;
    // --title overrides the generic window title that play.mjs sets.
    const extra = [`--input-ipc-server=${session.pipe}`, `--force-media-title=${mediaTitle}`, `--title=${mediaTitle} · Animora`];
    if (resumeAt > 5) extra.push(`--start=${Math.floor(resumeAt)}`);
    if (settings.subtitles === false) extra.push("--sub-visibility=no");
    if (settings.fullscreen) extra.push("--fullscreen");

    const logFile = openLog(logDir, `${moduleName} ${language} EP ${episode.number} ${episode.href}\nmpv: ${mpvPath}`);

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--use-system-ca", playerScript, moduleName, episode.href, language], {
        cwd: root,
        windowsHide: false,
        env: { ...env, SYNTHETIQ_MPV_ARGS: JSON.stringify(extra) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      session.child = child;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let graceTimer = null;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(resolveTimer);
        clearTimeout(graceTimer);
        fn(value);
      };
      const started = () => {
        onPlay({ show, episode, language });
        if (session.state === "resolving") setState(session, "starting");
        settle(resolve, {
          started: true,
          subtitle: /^Sub:\s/m.test(stdout),
          problem: session.message,
          logFile: logFile.file,
        });
      };
      const resolveTimer = setTimeout(() => {
        killTree(child.pid);
        settle(reject, new Error("Zeitüberschreitung beim Auflösen des Streams."));
      }, RESOLVE_TIMEOUT_MS);

      // Drain both pipes for the player's whole lifetime: mpv inherits them from
      // play.mjs and would block as soon as a full pipe is no longer read.
      const collect = (chunk, isError) => {
        const text = chunk.toString();
        logFile.stream?.write(text);
        if (isError) stderr = (stderr + text).slice(-20000);
        else stdout = (stdout + text).slice(-20000);
        if (!session.message) {
          const problem = playbackProblem(stdout + stderr);
          if (problem) setState(session, "problem", problem);
        }
        if (!settled && !graceTimer && stdout.includes("Starte mpv")) {
          connectIpc(session);
          graceTimer = setTimeout(started, PLAYER_GRACE_MS);
        }
      };
      child.stdout.on("data", (chunk) => collect(chunk, false));
      child.stderr.on("data", (chunk) => collect(chunk, true));

      child.on("error", (error) => {
        log(`Player-Prozess konnte nicht gestartet werden: ${error.message}`);
        settle(reject, new Error("Wiedergabe konnte nicht gestartet werden."));
      });
      child.on("close", (code) => {
        session.closed = true;
        session.socket?.destroy();
        logFile.stream?.end(`[exit ${code}]\n`);
        saveProgress(session, true);
        if (!settled) {
          if (code === 0 && graceTimer) {
            started();
          } else {
            log(`Wiedergabe fehlgeschlagen (Code ${code}): ${(stderr || stdout).slice(-2000)}`);
            session.state = "stopped";
            if (current === session) current = null;
            emit("player:state", publicState(session));
            settle(reject, new Error(friendlyError(stderr || stdout, "Wiedergabe konnte nicht gestartet werden.")));
            return;
          }
        }
        const failed = code !== 0 && !session.stopRequested && !session.message;
        if (failed) session.message = `mpv wurde unerwartet beendet (Code ${code}). Details stehen im Player-Protokoll.`;
        session.state = "stopped";
        if (current === session) current = null;
        emit("player:state", publicState(session, { failed }));
      });
    });
  }

  return {
    start,
    stop,
    current: () => (current ? publicState(current) : null),
  };
}

module.exports = { createPlayer };
