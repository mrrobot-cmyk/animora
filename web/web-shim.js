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
      '    <button class="wp-barnext" type="button" title="Nächste Folge (N)" hidden>Nächste Folge ⏭</button>' +
      '    <button class="wp-close" type="button" aria-label="Schließen">✕</button></div>' +
      '  <div class="wp-stage">' +
      '    <video class="wp-video" controls autoplay playsinline crossorigin="anonymous"></video>' +
      '    <div class="wp-actions">' +
      '      <button class="wp-btn wp-skip" type="button" title="Intro überspringen (S)" hidden>Intro überspringen ⏩</button>' +
      '      <span class="wp-group wp-nextgroup" hidden>' +
      '        <button class="wp-btn wp-next" type="button" title="Nächste Folge (N)">Nächste Folge ⏭</button>' +
      '        <button class="wp-btn wp-cancel" type="button" hidden>Abbrechen</button>' +
      '      </span>' +
      '    </div>' +
      '    <div class="wp-note" hidden></div>' +
      '  </div>' +
      '  <p class="wp-msg" hidden></p>' +
      "</div>";
    document.body.appendChild(overlay);
    const video = overlay.querySelector(".wp-video");
    overlay.querySelector(".wp-close").addEventListener("click", () => api.player.stop());
    overlay.querySelector(".wp-backdrop").addEventListener("click", () => api.player.stop());
    ui = {
      overlay, video, title: overlay.querySelector(".wp-title"), msg: overlay.querySelector(".wp-msg"),
      skip: overlay.querySelector(".wp-skip"), nextGroup: overlay.querySelector(".wp-nextgroup"),
      next: overlay.querySelector(".wp-next"), cancel: overlay.querySelector(".wp-cancel"),
      barNext: overlay.querySelector(".wp-barnext"), note: overlay.querySelector(".wp-note"),
    };
    ui.skip.addEventListener("click", () => skipIntro(false));
    ui.next.addEventListener("click", () => playNext());
    ui.barNext.addEventListener("click", () => playNext());
    ui.cancel.addEventListener("click", () => { cancelCountdown(); nextDismissed = true; updateActions(); });
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
      updateActions();
    };
    video.onended = () => {
      if (!session) return;
      session.position = session.duration; saveProgress(true); setState("ended");
      updateActions();
      if (currentSettings().autoNext !== false) startCountdown();
    };
    video.onerror = () => setState("problem", "Der Stream konnte nicht geladen werden. Bitte andere Quelle oder später erneut versuchen.");
  }

  // ---------- Intro überspringen & nächste Folge ----------

  // Ohne Intro-Zeiten von der Quelle: manueller Sprung um die typische Intro-Länge.
  const FALLBACK_INTRO_SKIP = 85;
  const FALLBACK_INTRO_WINDOW = 240;  // Knopf nur in den ersten 4 Minuten
  const NEXT_BEFORE_END = 100;        // ohne Outro-Zeiten: Knopf in den letzten 100 s
  const COUNTDOWN = 8;

  let playback = null;       // aktuelle Stream-Antwort (inkl. intro/outro)
  let introDone = false;     // Intro in dieser Folge schon übersprungen/verlassen
  let nextEpisode = null;    // vorab ermittelte nächste Folge (oder null)
  let nextDismissed = false; // Nutzer hat den Countdown abgebrochen
  let countdown = null;
  let noteTimer = null;

  function note(text) {
    if (!ui) return;
    ui.note.textContent = text; ui.note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { ui.note.hidden = true; }, 2500);
  }

  function resetExtras() {
    cancelCountdown();
    playback = null; introDone = false; nextEpisode = null; nextDismissed = false;
    if (ui) { ui.skip.hidden = true; ui.nextGroup.hidden = true; ui.barNext.hidden = true; ui.note.hidden = true; }
  }

  function introWindow() {
    const intro = playback && playback.intro;
    if (intro) return { start: intro.start, end: intro.end, known: true };
    return null;
  }

  function skipIntro(auto) {
    if (!ui || !session) return;
    const video = ui.video;
    const intro = introWindow();
    introDone = true;
    if (intro) video.currentTime = Math.max(video.currentTime, intro.end);
    else video.currentTime = Math.min((video.currentTime || 0) + FALLBACK_INTRO_SKIP, (video.duration || Infinity) - 1);
    ui.skip.hidden = true;
    if (auto) note("Intro übersprungen");
  }

  function available(ep, lang) {
    try { if (typeof episodeAvailable === "function") return episodeAvailable(ep, lang); } catch {}
    return true;
  }

  async function findNext(forSession) {
    const sep = forSession.key.indexOf("::");
    const moduleName = forSession.key.slice(0, sep), href = forSession.key.slice(sep + 2);
    const list = await api.episodes(moduleName, href);
    const sorted = (Array.isArray(list) ? list : []).slice().sort((a, b) => Number(a.number) - Number(b.number));
    return sorted.find((ep) => Number(ep.number) > Number(forSession.episode.number) && available(ep, forSession.language)) || null;
  }

  function nextStart() {
    if (!ui) return Infinity;
    const outro = playback && playback.outro;
    const duration = ui.video.duration;
    if (outro && outro.start > 0) return outro.start;
    return duration && isFinite(duration) ? Math.max(0, duration - NEXT_BEFORE_END) : Infinity;
  }

  function updateActions() {
    if (!ui || !session) return;
    const t = ui.video.currentTime || 0;
    const settingsNow = currentSettings();

    // Intro
    const intro = introWindow();
    if (intro) {
      const inIntro = t >= intro.start && t < intro.end - 1;
      if (inIntro && !introDone && settingsNow.autoSkipIntro !== false && t < intro.end - 2) skipIntro(true);
      else ui.skip.hidden = !inIntro;
      if (!inIntro && t >= intro.end) introDone = true;
    } else {
      ui.skip.hidden = introDone || t < 3 || t > FALLBACK_INTRO_WINDOW;
      ui.skip.textContent = introDone ? "" : `Intro überspringen (+${FALLBACK_INTRO_SKIP} s) ⏩`;
    }
    if (intro) ui.skip.textContent = "Intro überspringen ⏩";

    // Nächste Folge
    ui.barNext.hidden = !nextEpisode;
    const nearEnd = t >= nextStart() || session.state === "ended";
    ui.nextGroup.hidden = !(nextEpisode && nearEnd);
    if (!countdown) { ui.next.textContent = "Nächste Folge ⏭"; ui.cancel.hidden = true; }
  }

  function currentSettings() {
    try { if (typeof App !== "undefined" && App.library && App.library.settings) return App.library.settings; } catch {}
    return settings;
  }

  function startCountdown() {
    if (!ui || !nextEpisode || countdown || nextDismissed) return;
    let left = COUNTDOWN;
    ui.nextGroup.hidden = false; ui.cancel.hidden = false;
    const tick = () => {
      if (!ui) return;
      ui.next.textContent = `Nächste Folge in ${left} s ⏭`;
      if (left <= 0) { cancelCountdown(); playNext(); return; }
      left -= 1;
    };
    tick();
    countdown = setInterval(tick, 1000);
  }

  function cancelCountdown() {
    if (countdown) { clearInterval(countdown); countdown = null; }
    if (ui) { ui.cancel.hidden = true; ui.next.textContent = "Nächste Folge ⏭"; }
  }

  async function playNext() {
    if (!session) return;
    cancelCountdown();
    const current = session;
    let next = nextEpisode;
    if (!next) { try { next = await findNext(current); } catch {} }
    if (!next) { note(`Keine weitere Folge als ${String(current.language).toUpperCase()} verfügbar`); return; }
    saveProgress(true);
    const sep = current.key.indexOf("::");
    const moduleName = current.key.slice(0, sep), href = current.key.slice(sep + 2);
    let resumeAt = 0;
    try {
      const entry = App.library.history.find((e) => e.key === current.key);
      if (typeof resumePosition === "function") resumeAt = resumePosition(entry, next.number);
    } catch {}
    const request = {
      moduleName, show: { href, title: current.title, image: current.image },
      episode: { number: next.number, title: next.title || "", href: next.href },
      language: current.language, resumeAt,
    };
    // Über die App-Funktion starten (Toasts, Tokens); sonst direkt.
    if (typeof playEpisode === "function") playEpisode(request).catch(() => {});
    else api.player.start(request).catch(() => {});
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
        resetExtras();
        teardownVideo(); // alte Folge sofort anhalten (z. B. bei „Nächste Folge“)
        title.textContent = `${request.show.title} · Episode ${request.episode.number} · ${String(request.language).toUpperCase()}`;
        const mySession = session;
        findNext(mySession).then((ep) => { if (session === mySession) { nextEpisode = ep; updateActions(); } }).catch(() => {});
        msg.hidden = true;
        overlay.hidden = false;
        document.body.classList.add("web-player-open");
        if (settings.fullscreen && !document.fullscreenElement) overlay.requestFullscreen().catch(() => {});
        setState("resolving");
        try {
          const resolved = await post("/api/player/resolve", {
            moduleName: request.moduleName, show: request.show, episode: request.episode, language: request.language,
          });
          if (mine !== token) return null;
          playback = resolved;
          // Beim Fortsetzen innerhalb des Intros nicht springen, danach gilt es als erledigt.
          if (playback.intro && request.resumeAt > playback.intro.start + 2) introDone = true;
          refreshLibrary();
          wireVideo(video);
          // Weiterschauen: erst springen, wenn die Laufzeit bekannt ist.
          video.addEventListener("loadedmetadata", () => { if (request.resumeAt > 5 && video.currentTime < 1) video.currentTime = request.resumeAt; }, { once: true });
          attach(video, resolved, settings);
          setState("starting");
          return { started: true, subtitle: !!resolved.subtitle, problem: "" };
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
        resetExtras();
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
    else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.altKey && !ui.skip.hidden) { e.preventDefault(); skipIntro(false); }
    else if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.altKey) { e.preventDefault(); playNext(); }
    else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else ui.overlay.requestFullscreen().catch(() => {});
    }
  }, true);

  window.synthetiq = api;
})();
