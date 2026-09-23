"use strict";
// Reusable UI building blocks: cards, rows, grids, loading/empty/error states.

// Module section titles in German; unknown titles are shown as delivered.
const SECTION_TITLES = {
  "Latest Updates": "Neue Folgen",
  "Top Trending": "Top-Trends",
  "New Releases": "Neuerscheinungen",
  "Featured": "Im Rampenlicht",
  "Featured Anime": "Im Rampenlicht",
  "Top 10 Most Popular": "Top 10 – am beliebtesten",
  "Trending on Anikage": "Gerade angesagt",
  "Top Rated Anime": "Bestbewertet",
  "Trending Anime": "Gerade angesagt",
  "Popular Anime": "Beliebt",
};

const sectionTitle = (title) => SECTION_TITLES[title] || title || "Weitere Titel";

function favoriteButton(moduleName, item, { label = false, className = "" } = {}) {
  const button = h("button", {
    class: `fav-button ${label ? "button button-secondary" : "icon-button card-action"} ${className}`.trim(),
    type: "button",
    dataset: { favKey: showKey(moduleName, item.href) },
    onClick: async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      await toggleFavorite(moduleName, item);
      button.disabled = false;
    },
  });
  button._label = label;
  updateFavoriteButton(button);
  return button;
}

function updateFavoriteButton(button) {
  const active = App.library.favorites.some((f) => f.key === button.dataset.favKey);
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
  const text = active ? "In Meiner Liste" : "Zu Meiner Liste";
  button.title = active ? "Aus Meiner Liste entfernen" : "Zu Meiner Liste hinzufügen";
  button.setAttribute("aria-label", button.title);
  setChildren(button, icon(active ? "bookmarkFilled" : "bookmark"), button._label ? h("span", { text }) : null);
}

function refreshFavoriteButtons() {
  document.querySelectorAll("[data-fav-key]").forEach(updateFavoriteButton);
}

function progressBar(ratio, className = "") {
  const bar = h("div", { class: `progress ${className}`.trim(), role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" });
  const value = Math.max(0, Math.min(1, Number(ratio) || 0));
  bar.setAttribute("aria-valuenow", String(Math.round(value * 100)));
  const fill = h("div", { class: "progress-fill" });
  fill.style.width = `${(value * 100).toFixed(1)}%`;
  bar.append(fill);
  return bar;
}

// Poster card for a module item: click opens the detail page, the play button
// opens it and starts the next episode.
function animeCard(moduleName, item, { rank = 0, meta = "" } = {}) {
  const title = item.title || "Unbekannter Titel";
  return h("article", { class: "card" },
    h("a", { class: "card-link", href: animeHref(moduleName, item), title },
      h("div", { class: "card-cover" },
        coverImage(item.image, title),
        rank ? h("span", { class: "card-rank", text: String(rank) }) : null,
        h("div", { class: "card-shade" })),
      h("div", { class: "card-body" },
        h("h3", { class: "card-title", text: title }),
        meta ? h("p", { class: "card-meta", text: meta }) : null)),
    h("div", { class: "card-actions" },
      h("a", { class: "icon-button card-action card-play", href: animeHref(moduleName, item, { autoplay: 1 }), title: "Abspielen", "aria-label": `${title} abspielen` }, icon("play")),
      favoriteButton(moduleName, item)));
}

// Card for "Weiterschauen": click resumes the last episode directly.
function continueCard(entry) {
  const episode = entry.lastEpisode || {};
  const progress = entry.episodes?.[episode.number];
  const ratio = progress?.duration > 0 ? progress.position / progress.duration : 0;
  const remaining = progress?.duration > 0 ? Math.max(0, progress.duration - progress.position) : 0;
  const meta = progress?.completed
    ? `EP ${episode.number} gesehen`
    : remaining > 0 ? `EP ${episode.number} · noch ${formatTime(remaining)}` : `EP ${episode.number}`;
  const show = { href: entry.href, title: entry.title, image: entry.image };
  const resume = async () => {
    try {
      await playEpisode({
        moduleName: entry.moduleName,
        show,
        episode,
        language: episode.lang || "sub",
        resumeAt: resumePosition(entry, episode.number),
      });
    } catch {}
  };
  return h("article", { class: "card card-continue" },
    h("button", { class: "card-link", type: "button", title: `${entry.title} – EP ${episode.number} fortsetzen`, onClick: resume },
      h("div", { class: "card-cover" },
        coverImage(entry.image, entry.title),
        h("div", { class: "card-shade" }),
        h("span", { class: "card-play-badge" }, icon("play")),
        h("span", { class: `lang-tag lang-${episode.lang || "sub"}`, text: (episode.lang || "sub").toUpperCase() }),
        progressBar(progress?.completed ? 1 : ratio, "card-progress")),
      h("div", { class: "card-body" },
        h("h3", { class: "card-title", text: entry.title }),
        h("p", { class: "card-meta", text: meta }))),
    h("div", { class: "card-actions" },
      h("a", { class: "icon-button card-action", href: animeHref(entry.moduleName, show), title: "Details", "aria-label": `${entry.title}: Details` }, icon("info"))));
}

// Horizontal row with scroll buttons.
function row(title, cards, { action = null, subtitle = "" } = {}) {
  const track = h("div", { class: "row-track" }, cards);
  const scrollBy = (direction) => track.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: "smooth" });
  const prev = h("button", { class: "row-arrow row-arrow-prev", type: "button", "aria-label": "Nach links blättern", onClick: () => scrollBy(-1) }, icon("back"));
  const next = h("button", { class: "row-arrow row-arrow-next", type: "button", "aria-label": "Nach rechts blättern", onClick: () => scrollBy(1) }, icon("forward"));
  const update = () => {
    prev.hidden = track.scrollLeft < 8;
    next.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
  };
  track.addEventListener("scroll", update, { passive: true });
  requestAnimationFrame(update);
  return h("section", { class: "row" },
    h("header", { class: "row-header" },
      h("div", {}, h("h2", { class: "row-title", text: title }), subtitle ? h("p", { class: "row-subtitle", text: subtitle }) : null),
      action),
    h("div", { class: "row-viewport" }, prev, track, next));
}

function grid(cards) {
  return h("div", { class: "card-grid" }, cards);
}

// ---------- loading, empty and error states ----------

function skeletonCards(count) {
  return Array.from({ length: count }, () => h("div", { class: "card skeleton-card" },
    h("div", { class: "card-cover skeleton" }),
    h("div", { class: "skeleton skeleton-line" }),
    h("div", { class: "skeleton skeleton-line short" })));
}

function skeletonRow(count = 8) {
  return h("section", { class: "row" },
    h("header", { class: "row-header" }, h("div", { class: "skeleton skeleton-heading" })),
    h("div", { class: "row-viewport" }, h("div", { class: "row-track" }, skeletonCards(count))));
}

function skeletonGrid(count = 12) {
  return grid(skeletonCards(count));
}

function stateBlock({ icon: iconName = "info", title, text = "", actions = [], kind = "empty" }) {
  return h("div", { class: `state state-${kind}` },
    h("div", { class: "state-icon" }, icon(iconName)),
    h("h2", { class: "state-title", text: title }),
    text ? h("p", { class: "state-text", text }) : null,
    actions.length ? h("div", { class: "state-actions" }, actions) : null);
}

function emptyState(options) {
  return stateBlock({ kind: "empty", ...options });
}

function errorState({ title, text, onRetry }) {
  return stateBlock({
    kind: "error",
    icon: "alert",
    title,
    text,
    actions: onRetry ? [h("button", { class: "button button-secondary", type: "button", onClick: onRetry }, icon("refresh"), h("span", { text: "Erneut versuchen" }))] : [],
  });
}

function pageHeader(title, subtitle = "", extra = null) {
  return h("header", { class: "page-header" },
    h("div", {}, h("h1", { class: "page-title", text: title }), subtitle ? h("p", { class: "page-subtitle", text: subtitle }) : null),
    extra);
}
