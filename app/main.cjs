const { app, BrowserWindow, ipcMain, shell, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createStore, libraryKey } = require("./lib/store.cjs");
const { createCatalogue, friendlyError } = require("./lib/catalogue.cjs");
const { createPlayer } = require("./lib/player.cjs");

// Optional separate profile folder (used for tests and portable setups).
if (process.env.SYNTHETIQ_PROFILE_DIR) {
  app.setPath("userData", path.resolve(process.env.SYNTHETIQ_PROFILE_DIR));
}

// Development: the project folder. Packaged: src/ and modules/ are unpacked
// next to app.asar ("asarUnpack" in package.json), because app.asar is a file
// and cannot be used as the working directory of a child process.
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked")
  : path.resolve(__dirname, "..");
const MPV_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "mpv", "mpv.exe")
  : path.join(ROOT, "mpv", "mpv.exe");
const USER_DATA = app.getPath("userData");
const LOG_DIR = path.join(USER_DATA, "logs");

function log(message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, "app.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.rmSync(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function nodeEnvironment() {
  return {
    ...process.env,
    // Run Electron's bundled Node runtime in Node mode for the existing V4
    // harness. Using the Windows certificate store preserves TLS validation.
    ELECTRON_RUN_AS_NODE: "1",
    NODE_USE_SYSTEM_CA: "1",
    MPV_PATH,
  };
}

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

// The app used to be called "Synthetiq" and kept its data in the sibling
// folder %APPDATA%\Synthetiq. Take over that library once, as a copy.
function migrateLegacyLibrary() {
  const target = path.join(USER_DATA, "library.json");
  const legacy = path.join(path.dirname(USER_DATA), "Synthetiq", "library.json");
  if (path.resolve(legacy) === path.resolve(target) || fs.existsSync(target) || !fs.existsSync(legacy)) return;
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.copyFileSync(legacy, target);
    log(`Bibliothek aus ${legacy} übernommen`);
  } catch (error) {
    log(`Bibliothek aus ${legacy} konnte nicht übernommen werden: ${error.message}`);
  }
}
migrateLegacyLibrary();

const store = createStore(path.join(USER_DATA, "library.json"));
const catalogue = createCatalogue({ root: ROOT, env: nodeEnvironment(), cacheDir: path.join(USER_DATA, "cache"), log });
const libraryChanged = () => broadcast("library:changed", store.snapshot());
const player = createPlayer({
  root: ROOT,
  mpvPath: MPV_PATH,
  env: nodeEnvironment(),
  logDir: LOG_DIR,
  friendlyError,
  log,
  emit: broadcast,
  onPlay: ({ show, episode, language }) => {
    store.recordPlay({ show, episode, language });
    libraryChanged();
  },
  onProgress: (key, episodeNumber, progress) => {
    store.recordProgress(key, episodeNumber, progress);
    libraryChanged();
  },
});

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width: Math.min(1440, Math.round(area.width * 0.92)),
    height: Math.min(900, Math.round(area.height * 0.92)),
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0a10",
    title: "Animora",
    icon: path.join(__dirname, "assets", "icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0b0a10", symbolColor: "#e9e3ef", height: 48 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.loadFile(path.join(__dirname, "index.html"));

  // The app is a single local page: no navigation away, no pop-up windows.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Mouse back/forward buttons.
  window.on("app-command", (_, command) => {
    const history = window.webContents.navigationHistory;
    if (command === "browser-backward" && history.canGoBack()) history.goBack();
    if (command === "browser-forward" && history.canGoForward()) history.goForward();
  });
  return window;
}

function registerIpc() {
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    mpvPath: MPV_PATH,
    mpvFound: fs.existsSync(MPV_PATH),
    dataDir: USER_DATA,
    logDir: LOG_DIR,
  }));
  ipcMain.handle("app:openLogs", () => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    return shell.openPath(LOG_DIR);
  });

  ipcMain.handle("catalogue:modules", () => catalogue.listModules());
  ipcMain.handle("catalogue:discovery", (_, { moduleName, force }) => catalogue.discovery(moduleName, { force }));
  ipcMain.handle("catalogue:cachedDiscovery", (_, { moduleName }) => catalogue.cachedDiscovery(moduleName));
  ipcMain.handle("catalogue:feed", (_, { moduleName, feedId, page }) => catalogue.feed(moduleName, feedId, page));
  ipcMain.handle("catalogue:search", (_, { moduleName, query, remember = true }) => {
    if (remember) {
      store.addRecentSearch(query);
      libraryChanged();
    }
    return catalogue.search(moduleName, query);
  });
  ipcMain.handle("catalogue:details", (_, { moduleName, href }) => catalogue.details(moduleName, href));
  ipcMain.handle("catalogue:episodes", (_, { moduleName, href }) => catalogue.episodes(moduleName, href));
  ipcMain.handle("catalogue:clearCache", () => catalogue.clear());

  ipcMain.handle("library:get", () => store.snapshot());
  ipcMain.handle("library:toggleFavorite", (_, item) => {
    const favorite = store.toggleFavorite(item);
    libraryChanged();
    return favorite;
  });
  ipcMain.handle("library:removeHistory", (_, { key }) => { store.removeHistory(key); libraryChanged(); });
  ipcMain.handle("library:clearHistory", () => { store.clearHistory(); libraryChanged(); });
  ipcMain.handle("library:clearRecentSearches", () => { store.clearRecentSearches(); libraryChanged(); });
  ipcMain.handle("library:setSettings", (_, patch) => {
    const settings = store.setSettings(patch);
    libraryChanged();
    return settings;
  });

  ipcMain.handle("player:start", (_, request) => {
    const show = {
      key: libraryKey(request.moduleName, request.show.href),
      moduleName: request.moduleName,
      href: request.show.href,
      title: request.show.title,
      image: request.show.image,
    };
    return player.start({
      moduleName: request.moduleName,
      show,
      episode: request.episode,
      language: request.language,
      resumeAt: Number(request.resumeAt) || 0,
      settings: store.snapshot().settings,
    });
  });
  ipcMain.handle("player:stop", () => player.stop());
  ipcMain.handle("player:current", () => player.current());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    log("Zweiter Start erkannt – vorhandenes Fenster wird angezeigt");
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  // Diagnostics for the log file: crashed or hanging processes.
  app.on("render-process-gone", (_, __, details) => log(`Renderer beendet: ${details.reason} (Code ${details.exitCode})`));
  app.on("child-process-gone", (_, details) => log(`Hilfsprozess beendet: ${details.type} ${details.reason} (Code ${details.exitCode})`));
  app.on("browser-window-created", (_, window) => {
    window.on("unresponsive", () => log("Fenster reagiert nicht"));
    window.on("responsive", () => log("Fenster reagiert wieder"));
  });

  app.whenReady().then(() => {
    log(`Start ${app.getVersion()} pid=${process.pid} (packaged=${app.isPackaged}) mpv=${MPV_PATH} exists=${fs.existsSync(MPV_PATH)}`);
    registerIpc();
    createWindow();
  });
  app.on("will-quit", () => log(`Beenden pid=${process.pid}`));

  // Close a running mpv together with the app, after it has reported its
  // final playback position.
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    if (player.current()) {
      event.preventDefault();
      player.stop().finally(() => {
        store.flush();
        app.quit();
      });
    } else {
      store.flush();
    }
  });

  app.on("window-all-closed", () => app.quit());
}
