"use strict";
// App shell: routing, navigation, source switch, now-playing bar, shortcuts.

const PAGES = {
  home: { page: HomePage, title: "Home", nav: "home" },
  search: { page: SearchPage, title: "Suche", nav: "search" },
  browse: { page: BrowsePage, title: "Entdecken", nav: "browse" },
  anime: { page: DetailPage, title: "Anime", nav: null },
  list: { page: ListPage, title: "Meine Liste", nav: "list" },
  history: { page: HistoryPage, title: "Verlauf", nav: "history" },
  settings: { page: SettingsPage, title: "Einstellungen", nav: "settings" },
};
// Pages whose content depends on the selected source.
const SOURCE_PAGES = new Set(["home", "search", "browse"]);

const view = document.querySelector("#view");
const sourceSelect = document.querySelector("#source-select");
const nowPlaying = document.querySelector("#now-playing");
let disposePage = null;
let currentRoute = null;

function renderRoute() {
  const route = parseRoute();
  const entry = PAGES[route.name] || PAGES.home;
  if (typeof disposePage === "function") {
    try { disposePage(); } catch (error) { console.error(error); }
  }
  disposePage = null;
  view.replaceChildren();
  view.scrollTop = 0;
  currentRoute = route;
  document.title = `${entry.title} – Animora`;
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.route === entry.nav;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  try {
    disposePage = entry.page.render(view, route.params) || null;
  } catch (error) {
    console.error(error);
    view.append(h("div", { class: "page page-inner" }, errorState({ title: "Diese Seite konnte nicht angezeigt werden", text: errorText(error) })));
  }
}

function fillSourceSelect() {
  setChildren(sourceSelect, App.modules.map((m) => h("option", { value: m.name }, m.name)));
  sourceSelect.value = currentModule();
}

// ---------- now playing ----------

let lastProblemId = 0;

async function playNextEpisode(state) {
  const separator = state.key.indexOf("::");
  const moduleName = state.key.slice(0, separator);
  const href = state.key.slice(separator + 2);
  try {
    const list = await api.episodes(moduleName, href);
    const sorted = (Array.isArray(list) ? list : []).sort((a, b) => Number(a.number) - Number(b.number));
    const next = sorted.find((ep) => Number(ep.number) > Number(state.episode.number) && episodeAvailable(ep, state.language));
    if (!next) {
      toast(`Keine weitere Episode als ${state.language.toUpperCase()} verfügbar.`, "info");
      return;
    }
    await playEpisode({ moduleName, show: { href, title: state.title, image: state.image }, episode: next, language: state.language });
  } catch {}
}

function renderNowPlaying(state) {
  if (!state || state.state === "stopped") {
    nowPlaying.hidden = true;
    document.body.classList.remove("has-now-playing");
    return;
  }
  const web = !!App.info?.web;
  const labels = {
    resolving: "Stream wird gesucht …",
    starting: web ? "Player startet …" : "mpv startet …",
    playing: web ? "Läuft" : "Läuft in mpv",
    ended: "Episode beendet",
    problem: "Nicht abspielbar",
  };
  const ratio = state.duration > 0 ? state.position / state.duration : 0;
  const separator = state.key.indexOf("::");
  const detailHref = routeHref("anime", { m: state.key.slice(0, separator), h: state.key.slice(separator + 2) });
  setChildren(nowPlaying,
    h("a", { class: "np-cover", href: detailHref, "aria-label": "Zur Detailseite" }, coverImage(state.image, state.title)),
    h("div", { class: "np-info" },
      h("p", { class: `np-state np-${state.state}` },
        state.state === "resolving" || state.state === "starting" ? h("span", { class: "spinner" }) : null,
        h("span", { text: labels[state.state] || "" })),
      h("p", { class: "np-title" }, h("strong", { text: state.title }), h("span", { text: ` · Episode ${state.episode?.number} · ${String(state.language).toUpperCase()}` })),
      state.state === "problem" ? h("p", { class: "np-message", text: state.message }) : null),
    h("div", { class: "np-progress" },
      progressBar(ratio),
      h("span", { class: "np-time", text: state.duration > 0 ? `${formatTime(state.position)} / ${formatTime(state.duration)}` : "" })),
    h("div", { class: "np-actions" },
      h("button", { class: "button button-secondary", type: "button", title: "Nächste Episode", onClick: () => playNextEpisode(state) }, icon("next"), h("span", { text: "Nächste" })),
      h("button", { class: "button button-secondary", type: "button", title: "Wiedergabe beenden", onClick: () => api.player.stop() }, icon("stop"), h("span", { text: "Stoppen" }))));
  nowPlaying.hidden = false;
  document.body.classList.add("has-now-playing");
}

function handlePlayerState(state) {
  setPlayer(state);
  renderNowPlaying(state);
  if (state?.state === "problem" && state.id !== lastProblemId) {
    lastProblemId = state.id;
    toast(state.message, "error", 9000);
  }
  if (state?.state === "stopped" && state.failed && state.message) toast(state.message, "error", 9000);
}

// ---------- start ----------

async function init() {
  // Placeholder spans become the icon; buttons keep themselves and get the icon inside.
  document.querySelectorAll("[data-icon]").forEach((node) => {
    const glyph = icon(node.dataset.icon);
    if (node.tagName === "SPAN") node.replaceWith(glyph);
    else node.append(glyph);
  });
  const [modules, library, info, player] = await Promise.all([
    api.modules().catch(() => []),
    api.library.get().catch(() => null),
    api.info().catch(() => null),
    api.player.current().catch(() => null),
  ]);
  App.modules = modules;
  App.info = info;
  if (library) setLibrary(library);
  fillSourceSelect();
  handlePlayerState(player);

  api.on("library:changed", (snapshot) => {
    const previousModule = currentModule();
    setLibrary(snapshot);
    const count = snapshot.favorites.length;
    const badge = document.querySelector("#list-count");
    badge.hidden = !count;
    badge.textContent = String(count);
    refreshFavoriteButtons();
    if (currentModule() !== previousModule) {
      sourceSelect.value = currentModule();
      if (SOURCE_PAGES.has(currentRoute?.name)) renderRoute();
    }
  });
  api.on("player:state", handlePlayerState);

  const count = App.library.favorites.length;
  const badge = document.querySelector("#list-count");
  badge.hidden = !count;
  badge.textContent = String(count);

  sourceSelect.addEventListener("change", () => {
    api.library.setSettings({ module: sourceSelect.value }).catch((error) => toast(errorText(error), "error"));
  });
  document.querySelector("#nav-back").addEventListener("click", () => history.back());
  document.querySelector("#nav-forward").addEventListener("click", () => history.forward());
  document.querySelector("#quick-search").addEventListener("click", () => {
    if (currentRoute?.name === "search") document.querySelector(".search-input")?.focus();
    else go("search");
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey && event.key.toLowerCase() === "k") || (event.ctrlKey && event.key.toLowerCase() === "f")) {
      event.preventDefault();
      if (currentRoute?.name === "search") document.querySelector(".search-input")?.focus();
      else go("search");
    } else if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      history.back();
    } else if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      history.forward();
    }
  });

  window.addEventListener("hashchange", renderRoute);
  renderRoute();
  document.body.classList.add("ready");
}

init();
