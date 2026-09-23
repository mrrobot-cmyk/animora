"use strict";
// "Meine Liste" (favourites) and "Verlauf" (watch history), both stored locally.

const ListPage = {
  render(view) {
    const sort = h("select", { class: "select", "aria-label": "Sortierung" },
      h("option", { value: "added" }, "Zuletzt hinzugefügt"),
      h("option", { value: "title" }, "Titel A–Z"));
    try { sort.value = localStorage.getItem("synthetiq.listSort") || "added"; } catch {}
    const subtitle = h("p", { class: "page-subtitle" });
    const content = h("div");
    view.append(h("div", { class: "page page-list page-inner" },
      h("header", { class: "page-header" },
        h("div", {}, h("h1", { class: "page-title", text: "Meine Liste" }), subtitle),
        sort),
      content));

    let signature = "";
    const render = (force = false) => {
      const favorites = [...App.library.favorites];
      const next = JSON.stringify([sort.value, favorites.map((f) => f.key)]);
      if (!force && next === signature) return;
      signature = next;
      subtitle.textContent = favorites.length ? `${favorites.length} ${favorites.length === 1 ? "Titel" : "Titel"} gespeichert` : "";
      if (!favorites.length) {
        setChildren(content, emptyState({
          icon: "bookmark",
          title: "Deine Liste ist noch leer",
          text: "Speichere Anime mit dem Lesezeichen-Symbol auf einer Karte oder der Detailseite, um sie hier wiederzufinden.",
          actions: [h("a", { class: "button button-primary", href: "#/browse" }, icon("compass"), h("span", { text: "Anime entdecken" }))],
        }));
        return;
      }
      if (sort.value === "title") favorites.sort((a, b) => a.title.localeCompare(b.title, "de"));
      setChildren(content, grid(favorites.map((f) => animeCard(f.moduleName, f, { meta: f.moduleName }))));
    };
    sort.addEventListener("change", () => {
      try { localStorage.setItem("synthetiq.listSort", sort.value); } catch {}
      render(true);
    });
    render(true);
    return onLibraryChange(() => render());
  },
};

function historyRow(entry) {
  const episode = entry.lastEpisode || {};
  const progress = entry.episodes?.[episode.number];
  const ratio = progress?.completed ? 1 : progress?.duration > 0 ? progress.position / progress.duration : 0;
  const show = { href: entry.href, title: entry.title, image: entry.image };
  const watchedCount = Object.values(entry.episodes || {}).filter((p) => p.completed).length;
  const progressText = progress?.completed ? "Gesehen"
    : progress?.position > 0 ? `${formatTime(progress.position)}${progress.duration ? ` von ${formatTime(progress.duration)}` : ""}`
    : "Gestartet";
  const resume = async () => {
    try {
      await playEpisode({ moduleName: entry.moduleName, show, episode, language: episode.lang || "sub", resumeAt: resumePosition(entry, episode.number) });
    } catch {}
  };
  return h("article", { class: "history-row" },
    h("a", { class: "history-cover", href: animeHref(entry.moduleName, show), "aria-label": `${entry.title}: Details` }, coverImage(entry.image, entry.title)),
    h("div", { class: "history-info" },
      h("a", { class: "history-title", href: animeHref(entry.moduleName, show), text: entry.title }),
      h("p", { class: "history-meta" },
        h("span", { text: `Episode ${episode.number}` }),
        h("span", { class: `lang-tag lang-${episode.lang || "sub"}`, text: (episode.lang || "sub").toUpperCase() }),
        h("span", { text: entry.moduleName }),
        h("span", { text: timeAgo(entry.updatedAt) })),
      h("div", { class: "history-progress" },
        progressBar(ratio),
        h("span", { class: "history-progress-text", text: progressText })),
      watchedCount ? h("p", { class: "history-watched", text: `${watchedCount} ${watchedCount === 1 ? "Episode" : "Episoden"} vollständig gesehen` }) : null),
    h("div", { class: "history-actions" },
      h("button", { class: "button button-primary", type: "button", onClick: resume }, icon("play"),
        h("span", { text: resumePosition(entry, episode.number) ? "Fortsetzen" : "Abspielen" })),
      h("button", {
        class: "icon-button", type: "button", title: "Aus dem Verlauf entfernen", "aria-label": `${entry.title} aus dem Verlauf entfernen`,
        onClick: () => api.library.removeHistory(entry.key).catch((error) => toast(errorText(error), "error")),
      }, icon("trash"))));
}

const HistoryPage = {
  render(view) {
    const clear = h("button", { class: "button button-secondary", type: "button" }, icon("trash"), h("span", { text: "Verlauf löschen" }));
    const content = h("div", { class: "history-list" });
    view.append(h("div", { class: "page page-history page-inner" },
      pageHeader("Verlauf", "Zuletzt angesehene Anime und Episoden – nur auf diesem PC gespeichert.", clear),
      content));

    let confirmTimer = null;
    clear.addEventListener("click", async () => {
      if (!clear.classList.contains("confirm")) {
        clear.classList.add("confirm");
        clear.querySelector("span:last-child").textContent = "Wirklich löschen?";
        confirmTimer = setTimeout(() => {
          clear.classList.remove("confirm");
          clear.querySelector("span:last-child").textContent = "Verlauf löschen";
        }, 4000);
        return;
      }
      clearTimeout(confirmTimer);
      await api.library.clearHistory().catch((error) => toast(errorText(error), "error"));
      toast("Verlauf gelöscht", "success");
    });

    let signature = "";
    const render = () => {
      const entries = App.library.history;
      const next = JSON.stringify(entries.map((e) => [e.key, e.updatedAt]));
      if (next === signature) return;
      signature = next;
      clear.hidden = !entries.length;
      if (!entries.length) {
        setChildren(content, emptyState({
          icon: "history",
          title: "Noch nichts angesehen",
          text: "Sobald du eine Episode startest, erscheint sie hier – inklusive Fortschritt zum Weiterschauen.",
          actions: [h("a", { class: "button button-primary", href: "#/home" }, icon("home"), h("span", { text: "Zur Startseite" }))],
        }));
        return;
      }
      setChildren(content, entries.map(historyRow));
    };
    render();
    const off = onLibraryChange(render);
    return () => {
      off();
      clearTimeout(confirmTimer);
    };
  },
};
