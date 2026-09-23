"use strict";
// Ersetzt die Electron-Bridge (window.synthetiq) im Browser-App-Modus:
// dieselbe API, aber über fetch zum lokalen Server, plus ein Video-Overlay,
// das die Wiedergabe per hls.js/<video> übernimmt (statt mpv).

(function () {
  const listeners = { "player:state": new Set(), "library:changed": new Set() };
  function emit(channel, payload) {
    for (const cb of [...(listeners[channel] || [])]) { try { cb(payload); } catch (e) { console.error(e); } }
  }

  async function j(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => null);
    if (data && data.error) throw new Error(data.error);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return data;
  }
  const q = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const post = (url, body) => j(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

  // Zuletzt bekannte Einstellungen: der Player braucht sie synchron beim Klick
  // (Vollbild ist nur direkt nach einer Nutzeraktion erlaubt).
  let settings = {};
  const remember = (library) => { if (library && library.settings) settings = library.settings; return library; };

  async function refreshLibrary() {
    try { emit("library:changed", remember(await j("/api/library"))); } catch {}
  }

  // Lebenszeichen an den Server; ohne sie beendet er sich (Fenster zu).
  const ping = () => fetch("/api/ping", { method: "POST" }).catch(() => {});
  ping();
  setInterval(ping, 5000);

  // ---------- Player-Overlay ----------

  let ui = null;
  function buildUi() {
    if (ui) return ui;
    const overlay = document.createElement("div");
    overlay.id = "web-player";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="wp-backdrop"></div>' +
      '<div class="wp-frame">' +
      '  <div class="wp-bar"><span class="wp-title"></span>' +
      '    <button class="wp-close" type="button" aria-label="Schließen">✕</button></div>' +
      '  <video class="wp-video" controls autoplay playsinline crossorigin="anonymous"></video>' +
      '  <p class="wp-msg" hidden></p>' +
      "</div>";
    document.body.appendChild(overlay);
    const video = overlay.querySelector(".wp-video");
    overlay.querySelector(".wp-close").addEventListener("click", () => api.player.stop());
    overlay.querySelector(".wp-backdrop").addEventListener("click", () => api.player.stop());
    ui = { overlay, video, title: overlay.querySelector(".wp-title"), msg: overlay.querySelector(".wp-msg") };
    return ui;
  }

  let session = null;   // aktueller Wiedergabezustand (publicState-Form)
  let hls = null;
  let token = 0;
  let lastSave = 0;

  function publicState(extra) {
    if (!session) return null;
    return Object.assign({
      id: session.id, key: session.key, title: session.title, image: session.image,
      episode: session.episode, language: session.language, state: session.state,
      position: session.position, duration: session.duration, message: session.message || "",
    }, extra || {});
  }
  function setState(state, message) {
    if (!session) return;
    session.state = state;
    if (message != null) session.message = message;
    emit("player:state", publicState());
  }

  function saveProgress(force) {
    if (!session || !(session.position > 0)) return;
    const now = Date.now();
    if (!force && now - lastSave < 5000) return;
    lastSave = now;
    const sep = session.key.indexOf("::");
    post("/api/player/progress", {
      moduleName: session.key.slice(0, sep), href: session.key.slice(sep + 2),
      episodeNumber: session.episode.number, position: session.position,
      duration: session.duration, language: session.language,
    }).catch(() => {});
  }

  function teardownVideo() {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    if (ui) { ui.video.removeAttribute("src"); try { ui.video.load(); } catch {} ui.video.replaceChildren(); }
  }

  function attach(video, playback, settings) {
    teardownVideo();
    if (playback.subtitle) {
      const track = document.createElement("track");
      track.kind = "subtitles"; track.label = "Untertitel"; track.srclang = "en";
      track.src = playback.subtitle; track.default = settings.subtitles !== false;
      video.appendChild(track);
    }
    if (playback.streamType === "hls" && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: false });
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (data && data.fatal) setState("problem", "Der Stream konnte nicht geladen werden. Bitte andere Quelle oder später erneut versuchen.");
      });
      hls.loadSource(playback.url);
      hls.attachMedia(video);
    } else {
      video.src = playback.url; // mp4 oder native HLS
    }
    video.play().catch(() => {});
  }

  function wireVideo(video) {
    video.ontimeupdate = () => {
      if (!session) return;
      session.position = video.currentTime || 0;
      if (video.duration && isFinite(video.duration)) session.duration = video.duration;
      if (session.state !== "playing" && !video.paused && session.position > 0) setState("playing");
      const now = Date.now();
      if (now - (session._emit || 0) > 1000) { session._emit = now; emit("player:state", publicState()); }
      saveProgress(false);
    };
    video.onended = () => { if (session) { session.position = session.duration; saveProgress(true); setState("ended"); } };
    video.onerror = () => setState("problem", "Der Stream konnte nicht geladen werden. Bitte andere Quelle oder später erneut versuchen.");
  }

  // ---------- öffentliche API ----------

  const api = {
    info: () => j("/api/info"),
    openLogs: () => post("/api/openLogs"),

    modules: () => j("/api/modules"),
    discovery: (module, force = false) => j(`/api/discovery?${q({ module, force: force ? 1 : "" })}`),
    cachedDiscovery: (module) => j(`/api/cachedDiscovery?${q({ module })}`),
    feed: (module, feedId, page) => j(`/api/feed?${q({ module, feedId, page })}`),
    search: (module, query, options = {}) => j(`/api/search?${q({ module, q: query, remember: options.remember === false ? 0 : "" })}`)
      .then((r) => { refreshLibrary(); return r; }),
    details: (module, href) => j(`/api/details?${q({ module, href })}`),
    episodes: (module, href) => j(`/api/episodes?${q({ module, href })}`),
    clearCache: () => post("/api/clearCache"),

    library: {
      get: () => j("/api/library").then(remember),
      toggleFavorite: (item) => post("/api/library/toggleFavorite", item).then((r) => { refreshLibrary(); return r; }),
      removeHistory: (key) => post("/api/library/removeHistory", { key }).then((r) => { refreshLibrary(); return r; }),
      clearHistory: () => post("/api/library/clearHistory").then((r) => { refreshLibrary(); return r; }),
      clearRecentSearches: () => post("/api/library/clearRecentSearches").then((r) => { refreshLibrary(); return r; }),
      setSettings: (patch) => post("/api/library/setSettings", patch).then((r) => { refreshLibrary(); return r; }),
    },

    player: {
      async start(request) {
        const mine = ++token;
        const { overlay, video, title, msg } = buildUi();
        const sep = "::";
        session = {
          id: mine, key: `${request.moduleName}${sep}${request.show.href}`,
          title: request.show.title, image: request.show.image,
          episode: request.episode, language: request.language,
          state: "resolving", position: 0, duration: 0, message: "",
        };
        title.textContent = `${request.show.title} · Episode ${request.episode.number} · ${String(request.language).toUpperCase()}`;
        msg.hidden = true;
        overlay.hidden = false;
        document.body.classList.add("web-player-open");
        if (settings.fullscreen && !document.fullscreenElement) overlay.requestFullscreen().catch(() => {});
        setState("resolving");
        try {
          const playback = await post("/api/player/resolve", {
            moduleName: request.moduleName, show: request.show, episode: request.episode, language: request.language,
          });
          if (mine !== token) return null;
          refreshLibrary();
          wireVideo(video);
          // Weiterschauen: erst springen, wenn die Laufzeit bekannt ist.
          video.addEventListener("loadedmetadata", () => { if (request.resumeAt > 5 && video.currentTime < 1) video.currentTime = request.resumeAt; }, { once: true });
          attach(video, playback, settings);
          setState("starting");
          return { started: true, subtitle: !!playback.subtitle, problem: "" };
        } catch (error) {
          if (mine !== token) return null;
          session.message = String(error.message || error);
          msg.textContent = session.message; msg.hidden = false;
          setState("problem", session.message);
          throw error;
        }
      },
      async stop() {
        token++;
        saveProgress(true);
        teardownVideo();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        if (ui) { ui.overlay.hidden = true; ui.msg.hidden = true; }
        document.body.classList.remove("web-player-open");
        if (session) { session.state = "stopped"; emit("player:state", publicState()); session = null; }
        return true;
      },
      current: () => Promise.resolve(publicState()),
    },

    on(channel, callback) {
      if (!listeners[channel]) throw new Error(`Unknown event: ${channel}`);
      listeners[channel].add(callback);
      return () => listeners[channel].delete(callback);
    },
  };

  // Player-Tasten: Esc schließt, Leertaste pausiert, F schaltet Vollbild.
  document.addEventListener("keydown", (e) => {
    if (!session || !ui || ui.overlay.hidden) return;
    if (e.key === "Escape") { e.stopPropagation(); api.player.stop(); }
    else if (e.key === " " && e.target !== ui.video) { e.preventDefault(); ui.video.paused ? ui.video.play().catch(() => {}) : ui.video.pause(); }
    else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else ui.overlay.requestFullscreen().catch(() => {});
    }
  }, true);

  window.synthetiq = api;
})();
