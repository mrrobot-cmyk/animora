const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const EVENTS = new Set(["player:state", "library:changed"]);

contextBridge.exposeInMainWorld("synthetiq", {
  info: () => invoke("app:info"),
  openLogs: () => invoke("app:openLogs"),

  modules: () => invoke("catalogue:modules"),
  discovery: (moduleName, force = false) => invoke("catalogue:discovery", { moduleName, force }),
  cachedDiscovery: (moduleName) => invoke("catalogue:cachedDiscovery", { moduleName }),
  feed: (moduleName, feedId, page) => invoke("catalogue:feed", { moduleName, feedId, page }),
  // remember: false keeps helper searches (e.g. for typos) out of "Letzte Suchen".
  search: (moduleName, query, options = {}) => invoke("catalogue:search", { moduleName, query, remember: options.remember !== false }),
  details: (moduleName, href) => invoke("catalogue:details", { moduleName, href }),
  episodes: (moduleName, href) => invoke("catalogue:episodes", { moduleName, href }),
  clearCache: () => invoke("catalogue:clearCache"),

  library: {
    get: () => invoke("library:get"),
    toggleFavorite: (item) => invoke("library:toggleFavorite", item),
    removeHistory: (key) => invoke("library:removeHistory", { key }),
    clearHistory: () => invoke("library:clearHistory"),
    clearRecentSearches: () => invoke("library:clearRecentSearches"),
    setSettings: (patch) => invoke("library:setSettings", patch),
  },

  player: {
    start: (request) => invoke("player:start", request),
    stop: () => invoke("player:stop"),
    current: () => invoke("player:current"),
  },

  on: (channel, callback) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event: ${channel}`);
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
