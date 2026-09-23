// Local library: favourites, watch history with progress, recent searches and
// settings. Stored as one JSON file in the user's app data folder.
const fs = require("node:fs");
const path = require("node:path");

const MAX_HISTORY = 200;
const MAX_EPISODES_PER_ENTRY = 2000;
const MAX_RECENT_SEARCHES = 8;
const COMPLETED_RATIO = 0.9;

const DEFAULT_SETTINGS = {
  module: "Miruro",
  language: "sub",
  subtitles: true,
  resume: true,
  fullscreen: false,
};

function defaults() {
  return { version: 1, favorites: [], history: [], recentSearches: [], settings: { ...DEFAULT_SETTINGS } };
}

function libraryKey(moduleName, href) {
  return `${moduleName}::${href}`;
}

function normalize(raw) {
  const data = defaults();
  if (!raw || typeof raw !== "object") return data;
  if (Array.isArray(raw.favorites)) data.favorites = raw.favorites.filter((f) => f && f.key && f.href);
  if (Array.isArray(raw.history)) data.history = raw.history.filter((h) => h && h.key && h.href);
  if (Array.isArray(raw.recentSearches)) data.recentSearches = raw.recentSearches.filter((q) => typeof q === "string");
  data.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...(raw.settings || {}) });
  return data;
}

function sanitizeSettings(settings) {
  return {
    module: typeof settings.module === "string" && settings.module ? settings.module : DEFAULT_SETTINGS.module,
    language: settings.language === "dub" ? "dub" : "sub",
    subtitles: settings.subtitles !== false,
    resume: settings.resume !== false,
    fullscreen: settings.fullscreen === true,
  };
}

function pickShow(item) {
  return {
    key: libraryKey(item.moduleName, item.href),
    moduleName: String(item.moduleName || ""),
    href: String(item.href || ""),
    title: String(item.title || ""),
    image: String(item.image || ""),
  };
}

function createStore(file) {
  let data = load();
  let timer = null;

  function load() {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return defaults();
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(data, null, 2));
      fs.renameSync(temp, file);
    } catch {
      try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
    }
  }

  function save() {
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }

  function historyEntry(key) {
    return data.history.find((entry) => entry.key === key);
  }

  return {
    file,
    snapshot: () => structuredClone(data),

    toggleFavorite(item) {
      const show = pickShow(item);
      const index = data.favorites.findIndex((f) => f.key === show.key);
      if (index >= 0) data.favorites.splice(index, 1);
      else data.favorites.unshift({ ...show, addedAt: Date.now() });
      save();
      return index < 0;
    },

    recordPlay({ show, episode, language }) {
      const base = pickShow(show);
      const existing = historyEntry(base.key);
      const entry = existing || { ...base, episodes: {} };
      Object.assign(entry, {
        title: base.title || entry.title,
        image: base.image || entry.image,
        lastEpisode: {
          number: Number(episode.number) || 0,
          title: String(episode.title || ""),
          href: String(episode.href || ""),
          lang: language === "dub" ? "dub" : "sub",
        },
        updatedAt: Date.now(),
      });
      data.history = [entry, ...data.history.filter((h) => h.key !== base.key)].slice(0, MAX_HISTORY);
      save();
      return entry;
    },

    recordProgress(key, episodeNumber, { position, duration, language }) {
      const entry = historyEntry(key);
      if (!entry || !(position >= 0)) return;
      entry.episodes = entry.episodes || {};
      const previous = entry.episodes[episodeNumber] || {};
      const completed = duration > 0 && position / duration >= COMPLETED_RATIO;
      entry.episodes[episodeNumber] = {
        position: Math.round(position),
        duration: duration > 0 ? Math.round(duration) : previous.duration || 0,
        lang: language === "dub" ? "dub" : "sub",
        completed: completed || previous.completed === true,
        updatedAt: Date.now(),
      };
      const numbers = Object.keys(entry.episodes);
      if (numbers.length > MAX_EPISODES_PER_ENTRY) delete entry.episodes[numbers[0]];
      entry.updatedAt = Date.now();
      save();
    },

    removeHistory(key) {
      data.history = data.history.filter((h) => h.key !== key);
      save();
    },

    clearHistory() {
      data.history = [];
      save();
    },

    addRecentSearch(query) {
      const q = String(query || "").trim();
      if (!q) return;
      data.recentSearches = [q, ...data.recentSearches.filter((s) => s.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENT_SEARCHES);
      save();
    },

    clearRecentSearches() {
      data.recentSearches = [];
      save();
    },

    setSettings(patch) {
      data.settings = sanitizeSettings({ ...data.settings, ...(patch || {}) });
      save();
      return data.settings;
    },

    flush,
  };
}

module.exports = { createStore, libraryKey };
