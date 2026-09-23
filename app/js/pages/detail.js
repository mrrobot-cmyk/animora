"use strict";
// Anime detail page: artwork, metadata, SUB/DUB choice, episode list with
// ranges, filter and progress, and the play button.

const EPISODE_RANGE = 100;

// SUB/DUB flags exactly as the module reports them. Only when a module sends
// no flags at all is SUB assumed (every installed module is sub-first).
function episodeAvailable(episode, lang) {
  const flag = lang === "dub" ? episode.dubAvailable ?? episode.hasDub : episode.subAvailable ?? episode.hasSub;
  return flag === undefined ? lang === "sub" : Boolean(flag);
}

function episodeName(episode) {
  const cleaned = String(episode.title || "")
    .replace(/^S\d+E\d+:\s*/i, "")
    .replace(/^Episode\s+\d+:?\s*/i, "")
    .trim();
  return cleaned || `Episode ${episode.number}`;
}

const DetailPage = {
  render(view, params) {
    const moduleName = params.m;
    const href = params.h;
    if (!moduleName || !href || !App.modules.some((m) => m.name === moduleName)) {
      view.append(h("div", { class: "page page-inner" }, errorState({
        title: "Anime konnte nicht geladen werden",
        text: "Der Link ist unvollständig oder die Quelle ist nicht installiert.",
      })));
      return null;
    }

    const key = showKey(moduleName, href);
    const known = App.shows.get(key) || App.library.favorites.find((f) => f.key === key) || historyEntry(moduleName, href) || {};
    const show = { href, title: known.title || "", image: known.image || "" };

    let episodes = [];
    let language = App.library.settings.language === "dub" ? "dub" : "sub";
    let selected = null;
    let range = 0;
    let starting = false;
    let disposed = false;
    let entrySignature = "";

    // ---------- layout ----------
    const backdrop = h("div", { class: "detail-backdrop" });
    const poster = h("div", { class: "detail-poster" });
    const title = h("h1", { class: "detail-title", text: show.title || "Wird geladen …" });
    const altTitle = h("p", { class: "detail-alt-title" });
    altTitle.hidden = true;
    const chips = h("div", { class: "chips" });
    const description = h("p", { class: "detail-description clamped" });
    const moreButton = h("button", { class: "link-button", type: "button", text: "Mehr anzeigen" });
    moreButton.hidden = true;
    const playLabel = h("span", { text: "Episoden werden geladen …" });
    const playButton = h("button", { class: "button button-primary button-large detail-play", type: "button", disabled: true }, icon("play"), playLabel);
    const langButtons = ["sub", "dub"].map((lang) => h("button", {
      class: "segment", type: "button", dataset: { lang }, onClick: () => setLanguage(lang),
    }, h("span", { text: lang.toUpperCase() }), h("span", { class: "segment-count" })));
    const filter = h("input", { class: "episode-filter", type: "search", placeholder: "Episode suchen …", "aria-label": "Episode suchen" });
    const rangeTabs = h("div", { class: "range-tabs", role: "tablist", "aria-label": "Episodenbereich" });
    const listState = h("div", { class: "episodes-state" });
    const list = h("div", { class: "episode-list", role: "list" });
    const episodeCount = h("span", { class: "section-count" });

    setVisual(show.image, "");
    view.append(h("div", { class: "page page-detail" },
      h("section", { class: "detail-hero" },
        backdrop,
        h("div", { class: "detail-hero-shade" }),
        h("div", { class: "detail-hero-inner" },
          poster,
          h("div", { class: "detail-info" },
            h("p", { class: "eyebrow", text: moduleName }),
            title, altTitle, chips, description, moreButton,
            h("div", { class: "detail-actions" }, playButton, favoriteButton(moduleName, show, { label: true, className: "button-large" }))))),
      h("section", { class: "page-inner episodes-section" },
        h("header", { class: "episodes-header" },
          h("h2", { class: "row-title" }, "Episoden", episodeCount),
          h("div", { class: "episodes-tools" },
            h("div", { class: "segmented", role: "group", "aria-label": "Sprache" }, langButtons),
            filter)),
        rangeTabs, listState, list)));

    // ---------- helpers ----------
    function setVisual(image, banner) {
      setChildren(backdrop, coverImage(banner || image, "", "detail-backdrop-image"));
      backdrop.classList.toggle("is-banner", Boolean(banner));
      setChildren(poster, coverImage(image, show.title, "detail-poster-image"));
    }

    const entry = () => historyEntry(moduleName, href);

    function targetEpisode() {
      if (selected) return selected;
      const last = entry()?.lastEpisode;
      const available = episodes.filter((ep) => episodeAvailable(ep, language));
      if (last) {
        const index = available.findIndex((ep) => Number(ep.number) === Number(last.number));
        if (index >= 0) {
          const done = entry()?.episodes?.[last.number]?.completed;
          return done && available[index + 1] ? available[index + 1] : available[index];
        }
      }
      return available[0] || null;
    }

    function updatePlayButton() {
      const episode = targetEpisode();
      playButton.classList.toggle("working", starting);
      if (starting) return;
      if (!episodes.length) {
        playButton.disabled = true;
        return;
      }
      if (!episode || !episodeAvailable(episode, language)) {
        playButton.disabled = true;
        playLabel.textContent = `Nicht als ${language.toUpperCase()} verfügbar`;
        return;
      }
      playButton.disabled = false;
      const resume = resumePosition(entry(), episode.number);
      playLabel.textContent = resume
        ? `Fortsetzen · EP ${episode.number} ab ${formatTime(resume)}`
        : `EP ${episode.number} abspielen · ${language.toUpperCase()}`;
    }

    function updateLanguageButtons() {
      for (const button of langButtons) {
        const lang = button.dataset.lang;
        const count = episodes.filter((ep) => episodeAvailable(ep, lang)).length;
        button.setAttribute("aria-pressed", String(lang === language));
        button.querySelector(".segment-count").textContent = episodes.length ? String(count) : "";
        button.disabled = episodes.length > 0 && count === 0;
        button.title = button.disabled ? `Keine Episode als ${lang.toUpperCase()} verfügbar` : `${lang === "sub" ? "Untertitel" : "Synchronisation"} (${count} Episoden)`;
      }
    }

    function ranges() {
      const out = [];
      for (let i = 0; i < episodes.length; i += EPISODE_RANGE) out.push(episodes.slice(i, i + EPISODE_RANGE));
      return out;
    }

    function renderRanges() {
      const groups = ranges();
      rangeTabs.hidden = groups.length < 2 || Boolean(filter.value.trim());
      setChildren(rangeTabs, groups.map((group, index) => h("button", {
        class: `range-tab ${index === range ? "active" : ""}`,
        type: "button",
        role: "tab",
        "aria-selected": String(index === range),
        onClick: () => { range = index; renderRanges(); renderList(); },
      }, `${group[0].number}–${group[group.length - 1].number}`)));
    }

    function episodeRow(episode) {
      const available = episodeAvailable(episode, language);
      const progress = entry()?.episodes?.[episode.number];
      const playingNow = App.player?.key === key && Number(App.player.episode?.number) === Number(episode.number);
      const ratio = progress?.completed ? 1 : progress?.duration > 0 ? progress.position / progress.duration : 0;
      const status = playingNow ? "Läuft gerade"
        : progress?.completed ? "Gesehen"
        : progress?.position > 0 ? `${formatTime(progress.position)}${progress.duration ? ` / ${formatTime(progress.duration)}` : ""}`
        : "";
      return h("div", {
        class: `episode-row${episode === selected ? " selected" : ""}${available ? "" : " unavailable"}${playingNow ? " playing" : ""}${progress?.completed ? " watched" : ""}`,
        role: "listitem",
      },
        h("button", {
          class: "episode-main", type: "button", disabled: !available,
          title: available ? "Auswählen · Doppelklick spielt ab" : `Nicht als ${language.toUpperCase()} verfügbar`,
          onClick: () => select(episode),
          onDblclick: () => start(episode),
        },
          h("span", { class: "episode-number", text: String(episode.number) }),
          h("span", { class: "episode-text" },
            h("span", { class: "episode-title", text: episodeName(episode) }),
            h("span", { class: "episode-meta" },
              h("span", { class: `badge badge-sub${episodeAvailable(episode, "sub") ? "" : " off"}`, text: "SUB" }),
              h("span", { class: `badge badge-dub${episodeAvailable(episode, "dub") ? "" : " off"}`, text: "DUB" }),
              status ? h("span", { class: "episode-status", text: status }) : null)),
          ratio > 0 ? progressBar(ratio, "episode-progress") : null),
        h("button", {
          class: "icon-button episode-play", type: "button", disabled: !available,
          title: `Episode ${episode.number} abspielen`, "aria-label": `Episode ${episode.number} abspielen`,
          onClick: () => start(episode),
        }, icon(playingNow ? "check" : "play")));
    }

    function renderList() {
      const query = filter.value.trim().toLowerCase();
      const visible = query
        ? episodes.filter((ep) => `${ep.number} ${ep.title || ""}`.toLowerCase().includes(query)).slice(0, 200)
        : ranges()[range] || [];
      setChildren(list, visible.map(episodeRow));
      if (episodes.length) {
        setChildren(listState, query && !visible.length ? h("p", { class: "muted", text: `Keine Episode passt zu „${filter.value.trim()}“.` }) : null);
      }
    }

    function select(episode) {
      selected = episode;
      renderList();
      updatePlayButton();
    }

    function setLanguage(lang) {
      if (lang === language) return;
      language = lang;
      if (selected && !episodeAvailable(selected, language)) selected = null;
      updateLanguageButtons();
      renderList();
      updatePlayButton();
    }

    async function start(episode) {
      if (!episode || starting || !episodeAvailable(episode, language)) return;
      starting = true;
      selected = episode;
      renderList();
      playLabel.textContent = "Stream wird gesucht …";
      playButton.disabled = true;
      updatePlayButton();
      try {
        const info = await playEpisode({ moduleName, show, episode, language, resumeAt: resumePosition(entry(), episode.number) });
        if (info && !info.problem) toast(`Episode ${episode.number} startet${App.info?.web ? "" : " in mpv"}${info.subtitle ? " · mit Untertiteln" : ""}`, "success");
      } catch {}
      starting = false;
      if (!disposed) {
        updatePlayButton();
        renderList();
      }
    }

    function renderDetails(raw) {
      const details = (Array.isArray(raw) ? raw[0] : raw) || {};
      if (details.title) {
        show.title = details.title;
        title.textContent = details.title;
      }
      const image = details.image || details.poster || show.image;
      if (!show.image && image) show.image = image;
      setVisual(image, details.banner || details.bannerImage || "");
      const alias = Array.isArray(details.aliases) ? details.aliases[0] : details.aliases;
      if (alias && alias !== show.title) {
        altTitle.textContent = alias;
        altTitle.hidden = false;
      }
      const total = Number(details.episodes || details.totalEpisodes);
      const genres = Array.isArray(details.genres) && details.genres.length <= 12 ? details.genres.slice(0, 8) : [];
      setChildren(chips,
        details.status ? h("span", { class: "chip", text: details.status }) : null,
        total > 0 ? h("span", { class: "chip", text: `${total} Episoden` }) : null,
        details.rating ? h("span", { class: "chip chip-accent", text: `★ ${details.rating}` }) : null,
        details.duration ? h("span", { class: "chip", text: `${details.duration} Min.` }) : null,
        details.airdate ? h("span", { class: "chip", text: details.airdate }) : null,
        genres.map((genre) => h("span", { class: "chip chip-outline", text: genre })));
      const text = String(details.description || "").trim();
      description.textContent = text || "Keine Beschreibung verfügbar.";
      description.classList.toggle("muted", !text);
      requestAnimationFrame(() => { moreButton.hidden = description.scrollHeight <= description.clientHeight + 2; });
    }

    moreButton.addEventListener("click", () => {
      const clamped = description.classList.toggle("clamped");
      moreButton.textContent = clamped ? "Mehr anzeigen" : "Weniger anzeigen";
    });
    playButton.addEventListener("click", () => start(targetEpisode()));
    filter.addEventListener("input", () => { renderRanges(); renderList(); });

    async function loadEpisodes() {
      setChildren(listState, h("div", { class: "episode-skeletons" }, Array.from({ length: 6 }, () => h("div", { class: "skeleton episode-skeleton" }))));
      try {
        const result = await api.episodes(moduleName, href);
        if (disposed) return false;
        episodes = (Array.isArray(result) ? result : [])
          .filter((ep) => ep && ep.href && Number.isFinite(Number(ep.number)))
          .sort((a, b) => Number(a.number) - Number(b.number));
      } catch (error) {
        if (disposed) return false;
        setChildren(listState, errorState({ title: "Episoden konnten nicht geladen werden", text: errorText(error), onRetry: loadEpisodes }));
        playLabel.textContent = "Keine Episoden";
        return false;
      }
      episodeCount.textContent = episodes.length ? String(episodes.length) : "";
      if (!episodes.length) {
        setChildren(listState, emptyState({ icon: "film", title: "Keine Episoden gefunden", text: "Die Quelle listet für diesen Titel keine Episoden." }));
        playLabel.textContent = "Keine Episoden";
        return false;
      }
      const other = language === "sub" ? "dub" : "sub";
      if (!episodes.some((ep) => episodeAvailable(ep, language)) && episodes.some((ep) => episodeAvailable(ep, other))) language = other;
      const target = targetEpisode();
      range = target ? Math.floor(episodes.indexOf(target) / EPISODE_RANGE) : 0;
      setChildren(listState);
      updateLanguageButtons();
      renderRanges();
      renderList();
      updatePlayButton();
      return true;
    }

    (async () => {
      const [details, loaded] = await Promise.allSettled([api.details(moduleName, href), loadEpisodes()]);
      if (disposed) return;
      if (details.status === "fulfilled") {
        renderDetails(details.value);
      } else {
        description.textContent = "Beschreibung konnte nicht geladen werden.";
        description.classList.add("muted");
        if (!show.title) title.textContent = "Unbekannter Titel";
      }
      entrySignature = JSON.stringify(entry() || null);
      if (params.autoplay && loaded.value) {
        // Drop the autoplay flag so "back" does not start playback again.
        history.replaceState(null, "", routeHref("anime", { m: moduleName, h: href }));
        start(targetEpisode());
      }
    })();

    const offLibrary = onLibraryChange(() => {
      const signature = JSON.stringify(entry() || null);
      if (signature === entrySignature || !episodes.length) return;
      entrySignature = signature;
      renderList();
      updatePlayButton();
    });
    const offPlayer = onPlayerChange(() => { if (episodes.length) renderList(); });
    return () => {
      disposed = true;
      offLibrary();
      offPlayer();
    };
  },
};
