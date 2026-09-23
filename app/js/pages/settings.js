"use strict";
// Einstellungen: playback preferences, source, local data and diagnostics.

function settingRow(label, description, control) {
  return h("div", { class: "setting-row" },
    h("div", { class: "setting-text" }, h("p", { class: "setting-label", text: label }), description ? h("p", { class: "setting-description", text: description }) : null),
    h("div", { class: "setting-control" }, control));
}

function toggleSwitch(key) {
  const button = h("button", { class: "switch", type: "button", role: "switch" }, h("span", { class: "switch-thumb" }));
  const sync = () => button.setAttribute("aria-checked", String(Boolean(App.library.settings[key])));
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api.library.setSettings({ [key]: !App.library.settings[key] });
    } catch (error) {
      toast(`Einstellung konnte nicht gespeichert werden. ${errorText(error)}`, "error");
    }
    button.disabled = false;
  });
  button.sync = sync;
  sync();
  return button;
}

function twoStepButton(label, confirmLabel, action) {
  const text = h("span", { text: label });
  const button = h("button", { class: "button button-secondary", type: "button" }, icon("trash"), text);
  let timer = null;
  button.addEventListener("click", async () => {
    if (!button.classList.contains("confirm")) {
      button.classList.add("confirm");
      text.textContent = confirmLabel;
      timer = setTimeout(() => { button.classList.remove("confirm"); text.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer);
    button.classList.remove("confirm");
    text.textContent = label;
    await action();
  });
  return button;
}

const SettingsPage = {
  render(view) {
    const toggles = [];
    const makeToggle = (key) => {
      const toggle = toggleSwitch(key);
      toggles.push(toggle);
      return toggle;
    };

    const languageButtons = ["sub", "dub"].map((lang) => h("button", {
      class: "segment", type: "button", dataset: { lang },
      onClick: () => api.library.setSettings({ language: lang }).catch((error) => toast(errorText(error), "error")),
    }, lang === "sub" ? "SUB · Untertitel" : "DUB · Synchronisation"));

    const moduleSelect = h("select", { class: "select", "aria-label": "Standardquelle" },
      App.modules.map((m) => h("option", { value: m.name }, `${m.name}${m.version ? ` ${m.version}` : ""}${m.language ? ` – ${m.language}` : ""}`)));
    moduleSelect.addEventListener("change", () => api.library.setSettings({ module: moduleSelect.value }).catch((error) => toast(errorText(error), "error")));

    const info = App.info || {};
    // Browser-App-Modus (web/server.mjs): Wiedergabe im App-Fenster statt in mpv.
    const web = !!info.web;
    const infoList = h("dl", { class: "info-list" },
      h("dt", { text: "Version" }), h("dd", { text: info.version || "–" }),
      h("dt", { text: "Player" }), web
        ? h("dd", {}, h("span", { class: "status-dot ok" }), h("span", { text: "Integrierter Player (im App-Fenster)" }))
        : h("dd", {},
          h("span", { class: `status-dot ${info.mpvFound ? "ok" : "bad"}` }),
          h("span", { text: info.mpvFound ? "mpv gefunden" : "mpv nicht gefunden" }),
          h("code", { class: "path", text: info.mpvPath || "" })),
      h("dt", { text: "Datenordner" }), h("dd", {}, h("code", { class: "path", text: info.dataDir || "" })),
      h("dt", { text: "Installierte Module" }), h("dd", { text: App.modules.map((m) => `${m.name} ${m.version}`).join(", ") || "–" }));

    view.append(h("div", { class: "page page-settings page-inner" },
      pageHeader("Einstellungen", "Alle Einstellungen werden lokal auf diesem PC gespeichert."),
      h("section", { class: "settings-card" },
        h("h2", { class: "settings-heading", text: "Wiedergabe" }),
        settingRow("Bevorzugte Sprache", "Wird auf Detailseiten vorausgewählt, sofern die Episode in dieser Sprache verfügbar ist.",
          h("div", { class: "segmented" }, languageButtons)),
        settingRow("Untertitel anzeigen", web
          ? "Verfügbare englische Untertitel werden eingeblendet. Im Player jederzeit über das Menü umschaltbar."
          : "Verfügbare englische Untertitel werden eingeblendet. In mpv jederzeit mit „v“ umschaltbar.", makeToggle("subtitles")),
        settingRow("Fortsetzen, wo du aufgehört hast", "Startet eine angefangene Episode an der zuletzt gespeicherten Position.", makeToggle("resume")),
        settingRow("Im Vollbild starten", web
          ? "Der Player öffnet sich direkt im Vollbild. Beenden mit Esc."
          : "mpv öffnet sich direkt im Vollbild. Beenden mit Esc oder Doppelklick.", makeToggle("fullscreen"))),
      h("section", { class: "settings-card" },
        h("h2", { class: "settings-heading", text: "Quelle" }),
        settingRow("Standardquelle", "Für Startseite, Suche und Katalog. Auch oben rechts umschaltbar.", moduleSelect)),
      h("section", { class: "settings-card" },
        h("h2", { class: "settings-heading", text: "Daten" }),
        settingRow("Zwischenspeicher leeren", "Lädt Startseite, Suchergebnisse und Episodenlisten beim nächsten Aufruf neu.",
          h("button", {
            class: "button button-secondary", type: "button",
            onClick: async () => { await api.clearCache(); toast("Zwischenspeicher geleert", "success"); },
          }, icon("refresh"), h("span", { text: "Leeren" }))),
        settingRow("Suchverlauf löschen", "", twoStepButton("Löschen", "Wirklich löschen?", async () => {
          await api.library.clearRecentSearches();
          toast("Suchverlauf gelöscht", "success");
        })),
        settingRow("Wiedergabeverlauf löschen", "Entfernt „Weiterschauen“ und alle gespeicherten Fortschritte.", twoStepButton("Löschen", "Wirklich löschen?", async () => {
          await api.library.clearHistory();
          toast("Wiedergabeverlauf gelöscht", "success");
        }))),
      h("section", { class: "settings-card" },
        h("h2", { class: "settings-heading", text: "Info & Diagnose" }),
        infoList,
        h("div", { class: "settings-actions" },
          h("button", { class: "button button-secondary", type: "button", onClick: () => api.openLogs() }, icon("folder"), h("span", { text: "Protokolle öffnen" })))),
      h("section", { class: "settings-card" },
        h("h2", { class: "settings-heading", text: "Tastenkürzel" }),
        h("dl", { class: "info-list shortcuts" },
          h("dt", {}, h("kbd", { text: "Strg" }), " + ", h("kbd", { text: "K" })), h("dd", { text: "Suche öffnen" }),
          h("dt", {}, h("kbd", { text: "Alt" }), " + ", h("kbd", { text: "←" }), " / ", h("kbd", { text: "→" })), h("dd", { text: "Zurück / Vorwärts" }),
          web
            ? [h("dt", {}, h("kbd", { text: "Leertaste" }), " · ", h("kbd", { text: "F" }), " · ", h("kbd", { text: "Esc" })), h("dd", { text: "Im Player: Pause · Vollbild · Schließen" })]
            : [h("dt", {}, h("kbd", { text: "Leertaste" }), " · ", h("kbd", { text: "F" }), " · ", h("kbd", { text: "V" })), h("dd", { text: "Im mpv-Fenster: Pause · Vollbild · Untertitel" })]))));

    const sync = () => {
      toggles.forEach((toggle) => toggle.sync());
      languageButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.lang === App.library.settings.language)));
      moduleSelect.value = currentModule();
    };
    sync();
    return onLibraryChange(sync);
  },
};
