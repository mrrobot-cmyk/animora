"use strict";
// Shared helpers, app state, routing and playback for all pages.

const api = window.synthetiq;

// ---------- DOM ----------

const ICON_PATHS = {
  home: '<path d="M4 11.2 12 4.8l8 6.4V19a1 1 0 0 1-1 1h-4.6v-5.2H9.6V20H5a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1z"/>',
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z"/>',
  bookmarkFilled: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1z" fill="currentColor"/>',
  history: '<path d="M4.6 12a7.4 7.4 0 1 0 2.2-5.3"/><path d="M4.2 4.8v4h4"/><path d="M12 8.4V12l2.6 2"/>',
  settings: '<path d="M4.5 7h9.5M18.5 7h1M4.5 17h1.5M10.5 17h9"/><circle cx="16.2" cy="7" r="2.2"/><circle cx="8.2" cy="17" r="2.2"/>',
  play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.5.85l10.2-6.4a1 1 0 0 0 0-1.7L9.5 4.75A1 1 0 0 0 8 5.6z" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  forward: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12.2h8L17 7"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19.2 4.8v4.4h-4.4"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.6" fill="currentColor" stroke="none"/>',
  next: '<path d="M6 6.2v11.6a.8.8 0 0 0 1.2.7l8.4-5.8a.8.8 0 0 0 0-1.4L7.2 5.5A.8.8 0 0 0 6 6.2z" fill="currentColor" stroke="none"/><path d="M18.5 5.5v13"/>',
  alert: '<path d="M12 4.2 3.4 19h17.2z"/><path d="M12 10v4.2M12 16.6h.01"/>',
  folder: '<path d="M4 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>',
  film: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4"/>',
  grid: '<rect x="4.5" y="4.5" width="6" height="6" rx="1.2"/><rect x="13.5" y="4.5" width="6" height="6" rx="1.2"/><rect x="4.5" y="13.5" width="6" height="6" rx="1.2"/><rect x="13.5" y="13.5" width="6" height="6" rx="1.2"/>',
};

function icon(name, className = "") {
  const span = document.createElement("span");
  span.className = `icon ${className}`.trim();
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ""}</svg>`;
  return span;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// Like node.replaceChildren(), but skips null/false (replaceChildren would
// insert them as the text "null"/"false").
function setChildren(node, ...children) {
  node.replaceChildren();
  return append(node, children);
}

// h("button", { class: "x", onClick: fn, "aria-label": "…" }, children…)
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  return append(node, children);
}

function coverImage(src, title, className = "cover") {
  const fallback = () => h("div", { class: `${className} cover-fallback`, "aria-hidden": "true" },
    h("span", { text: (String(title || "").trim()[0] || "?").toUpperCase() }));
  if (!src) return fallback();
  const image = h("img", { class: className, src, alt: title || "", loading: "lazy", decoding: "async", draggable: "false" });
  image.addEventListener("error", () => image.replaceWith(fallback()), { once: true });
  return image;
}

// ---------- formatting ----------

function errorText(error) {
  return String(error?.message || error || "Unbekannter Fehler")
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^[A-Za-z]*Error:\s*/, "");
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function timeAgo(timestamp) {
  const diff = Math.max(0, Date.now() - Number(timestamp || 0));
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "gestern" : `vor ${days} Tagen`;
  return new Date(timestamp).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ---------- toasts ----------

function toast(message, kind = "info", duration = 3200) {
  const container = document.querySelector("#toasts");
  const node = h("div", { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" },
    icon(kind === "error" ? "alert" : kind === "success" ? "check" : "info"),
    h("span", { class: "toast-text", text: message }),
    h("button", { class: "toast-close", type: "button", "aria-label": "Schließen", onClick: () => dismiss() }, icon("close")));
  const dismiss = () => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 200);
  };
  container.append(node);
  setTimeout(dismiss, duration);
  while (container.children.length > 4) container.firstElementChild.remove();
}

// ---------- state ----------

const App = {
  modules: [],
  library: { favorites: [], history: [], recentSearches: [], settings: { module: "Miruro", language: "sub" } },
  info: null,
  player: null,
  // Titles/covers already known from cards, for an instant detail header.
  shows: new Map(),
  playToken: 0,
};

const libraryListeners = new Set();
const playerListeners = new Set();

function onLibraryChange(listener) {
  libraryListeners.add(listener);
  return () => libraryListeners.delete(listener);
}

function onPlayerChange(listener) {
  playerListeners.add(listener);
  return () => playerListeners.delete(listener);
}

function notify(listeners, value) {
  for (const listener of [...listeners]) {
    try { listener(value); } catch (error) { console.error(error); }
  }
}

function setLibrary(snapshot) {
  App.library = snapshot;
  notify(libraryListeners, snapshot);
}

function setPlayer(state) {
  App.player = state && state.state !== "stopped" ? state : null;
  notify(playerListeners, state);
}

const showKey = (moduleName, href) => `${moduleName}::${href}`;
const isFavorite = (moduleName, href) => App.library.favorites.some((f) => f.key === showKey(moduleName, href));
const historyEntry = (moduleName, href) => App.library.history.find((e) => e.key === showKey(moduleName, href));

function currentModule() {
  const wanted = App.library.settings.module;
  return App.modules.some((m) => m.name === wanted) ? wanted : App.modules[0]?.name || "Miruro";
}

function rememberShow(moduleName, item) {
  if (item?.href) App.shows.set(showKey(moduleName, item.href), { title: item.title || "", image: item.image || "" });
}

async function toggleFavorite(moduleName, item) {
  try {
    const added = await api.library.toggleFavorite({ moduleName, href: item.href, title: item.title, image: item.image });
    toast(added ? `„${item.title}“ zu Meiner Liste hinzugefügt` : `„${item.title}“ aus Meiner Liste entfernt`, "success");
    return added;
  } catch (error) {
    toast(`Meine Liste konnte nicht gespeichert werden: ${errorText(error)}`, "error");
    return isFavorite(moduleName, item.href);
  }
}

// ---------- routing ----------

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "") || "home";
  const [name, query = ""] = raw.split("?");
  return { name: name || "home", params: Object.fromEntries(new URLSearchParams(query)) };
}

function routeHref(name, params = {}) {
  const entries = Object.entries(params).filter(([, value]) => value != null && value !== "");
  const query = new URLSearchParams(entries).toString();
  return `#/${name}${query ? `?${query}` : ""}`;
}

function go(name, params) {
  location.hash = routeHref(name, params);
}

function animeHref(moduleName, item, extra = {}) {
  rememberShow(moduleName, item);
  return routeHref("anime", { m: moduleName, h: item.href, ...extra });
}

// ---------- playback ----------

// Seconds to resume from, or 0 when the episode should start at the beginning.
function resumePosition(entry, episodeNumber) {
  if (!App.library.settings.resume || !entry?.episodes) return 0;
  const progress = entry.episodes[episodeNumber];
  if (!progress || progress.completed || !(progress.position > 10)) return 0;
  if (progress.duration > 0 && progress.position > progress.duration * 0.95) return 0;
  return progress.position;
}

async function playEpisode({ moduleName, show, episode, language, resumeAt = 0 }) {
  const token = ++App.playToken;
  try {
    const info = await api.player.start({
      moduleName,
      show: { href: show.href, title: show.title, image: show.image },
      episode: { number: episode.number, title: episode.title || "", href: episode.href },
      language,
      resumeAt,
    });
    if (token !== App.playToken) return null;
    if (info?.problem) toast(info.problem, "error", 9000);
    return info;
  } catch (error) {
    if (token !== App.playToken) return null; // superseded by a newer start
    toast(`Wiedergabe konnte nicht gestartet werden. ${errorText(error)}`, "error", 9000);
    throw error;
  }
}
