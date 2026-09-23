"use strict";
// Home: hero with featured titles, "Weiterschauen", "Meine Liste" and the
// module's own discovery sections (no invented categories).

const HERO_INTERVAL_MS = 9000;

function continueRow() {
  const entries = App.library.history.filter((entry) => entry.lastEpisode).slice(0, 12);
  if (!entries.length) return null;
  return row("Weiterschauen", entries.map(continueCard), {
    action: h("a", { class: "row-link", href: "#/history" }, "Verlauf", icon("forward")),
  });
}

function favoritesRow() {
  const favorites = App.library.favorites.slice(0, 20);
  if (!favorites.length) return null;
  return row("Meine Liste", favorites.map((f) => animeCard(f.moduleName, f)), {
    action: h("a", { class: "row-link", href: "#/list" }, "Alle anzeigen", icon("forward")),
  });
}

function heroSlide(moduleName, item, sectionName) {
  const backdrop = coverImage(item.image, item.title, "hero-backdrop");
  const poster = coverImage(item.image, item.title, "hero-poster");
  const description = h("p", { class: "hero-description" });
  const chips = h("div", { class: "chips" });
  const slide = h("article", { class: "hero-slide" },
    h("div", { class: "hero-media" }, backdrop),
    h("div", { class: "hero-gradient" }),
    h("div", { class: "hero-content" },
      h("p", { class: "eyebrow", text: `${sectionName} · ${moduleName}` }),
      h("h1", { class: "hero-title", text: item.title }),
      chips,
      description,
      h("div", { class: "hero-actions" },
        h("a", { class: "button button-primary button-large", href: animeHref(moduleName, item, { autoplay: 1 }) }, icon("play"), h("span", { text: "Jetzt ansehen" })),
        h("a", { class: "button button-ghost button-large", href: animeHref(moduleName, item) }, icon("info"), h("span", { text: "Details" })),
        favoriteButton(moduleName, item, { label: true, className: "button-large" }))),
    h("div", { class: "hero-poster-frame" }, poster));

  // Wide artwork fills the hero; portrait covers get a blurred backdrop.
  if (backdrop.tagName === "IMG") {
    backdrop.addEventListener("load", () => {
      slide.classList.toggle("is-wide", backdrop.naturalWidth > backdrop.naturalHeight * 1.25);
    });
  }

  slide.loadDetails = async () => {
    if (slide.detailsLoaded) return;
    slide.detailsLoaded = true;
    try {
      const raw = await api.details(moduleName, item.href);
      const details = (Array.isArray(raw) ? raw[0] : raw) || {};
      const text = String(details.description || "").trim();
      description.textContent = text;
      const total = Number(details.episodes || details.totalEpisodes);
      setChildren(chips,
        details.status ? h("span", { class: "chip", text: details.status }) : null,
        total > 0 ? h("span", { class: "chip", text: `${total} Episoden` }) : null);
    } catch {
      slide.detailsLoaded = false;
    }
  };
  return slide;
}

function buildHero(moduleName, section) {
  const items = (section.items || []).filter((item) => item.href && item.title).slice(0, 6);
  if (!items.length) return null;
  const slides = items.map((item) => heroSlide(moduleName, item, sectionTitle(section.title)));
  const dots = items.map((item, index) => h("button", {
    class: "hero-dot", type: "button", "aria-label": `${index + 1}: ${item.title}`, onClick: () => show(index, true),
  }));
  let active = -1;
  let timer = null;

  const show = (index, manual = false) => {
    const next = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => slide.classList.toggle("active", i === next));
    dots.forEach((dot, i) => dot.setAttribute("aria-current", String(i === next)));
    active = next;
    slides[next].loadDetails();
    if (manual) restart();
  };
  const restart = () => {
    clearInterval(timer);
    if (slides.length > 1) timer = setInterval(() => show(active + 1), HERO_INTERVAL_MS);
  };

  const hero = h("section", { class: "hero", "aria-roledescription": "Karussell" },
    slides,
    slides.length > 1 ? h("div", { class: "hero-controls" },
      h("button", { class: "icon-button hero-arrow", type: "button", "aria-label": "Vorheriger Titel", onClick: () => show(active - 1, true) }, icon("back")),
      h("div", { class: "hero-dots" }, dots),
      h("button", { class: "icon-button hero-arrow", type: "button", "aria-label": "Nächster Titel", onClick: () => show(active + 1, true) }, icon("forward"))) : null);
  hero.addEventListener("mouseenter", () => clearInterval(timer));
  hero.addEventListener("mouseleave", restart);
  show(0);
  restart();
  hero.dispose = () => clearInterval(timer);
  return hero;
}

const HomePage = {
  render(view) {
    const moduleName = currentModule();
    const heroSlot = h("div", { class: "hero-slot" }, h("section", { class: "hero hero-skeleton" }, h("div", { class: "skeleton hero-skeleton-fill" })));
    const personal = h("div", { class: "rows" });
    const sections = h("div", { class: "rows" }, skeletonRow(), skeletonRow());
    view.append(h("div", { class: "page page-home" }, heroSlot, h("div", { class: "page-inner" }, personal, sections)));

    let disposed = false;
    let hero = null;
    let personalSignature = "";

    const renderPersonal = () => {
      const signature = JSON.stringify([
        App.library.favorites.map((f) => f.key),
        App.library.history.slice(0, 12).map((e) => [e.key, e.lastEpisode?.number, e.lastEpisode?.lang, Math.round((e.episodes?.[e.lastEpisode?.number]?.position || 0) / 30)]),
      ]);
      if (signature === personalSignature) return;
      personalSignature = signature;
      personal.replaceChildren(...[continueRow(), favoritesRow()].filter(Boolean));
    };

    const renderData = (data) => {
      const list = (data?.sections || []).filter((s) => Array.isArray(s.items) && s.items.length);
      const heroSection = list.find((s) => s.style === "hero") || list[0];
      hero?.dispose();
      hero = heroSection ? buildHero(moduleName, heroSection) : null;
      heroSlot.replaceChildren(...(hero ? [hero] : []));
      const rows = list.filter((s) => s !== heroSection).map((s) => row(
        sectionTitle(s.title),
        s.items.map((item, index) => animeCard(moduleName, item, { rank: s.style === "top10" ? index + 1 : 0 })),
        { action: s.viewAll?.feedId ? h("a", { class: "row-link", href: routeHref("browse", { feed: s.viewAll.feedId }) }, "Alle anzeigen", icon("forward")) : null },
      ));
      sections.replaceChildren(...rows);
      if (!hero && !rows.length) {
        sections.replaceChildren(emptyState({ icon: "compass", title: "Keine Empfehlungen verfügbar", text: `${moduleName} liefert derzeit keine Startseiten-Daten. Die Suche funktioniert trotzdem.` }));
      }
    };

    const load = async (force = false) => {
      const cached = force ? null : await api.cachedDiscovery(moduleName).catch(() => null);
      if (cached && !disposed) renderData(cached);
      try {
        const fresh = await api.discovery(moduleName, force);
        if (!disposed) renderData(fresh);
      } catch (error) {
        if (disposed) return;
        if (cached) {
          toast(`Startseite konnte nicht aktualisiert werden. ${errorText(error)}`, "error");
        } else {
          heroSlot.replaceChildren();
          sections.replaceChildren(errorState({
            title: "Startseite konnte nicht geladen werden",
            text: errorText(error),
            onRetry: () => { sections.replaceChildren(skeletonRow(), skeletonRow()); load(true); },
          }));
        }
      }
    };

    renderPersonal();
    const off = onLibraryChange(renderPersonal);
    load();
    return () => {
      disposed = true;
      off();
      hero?.dispose();
    };
  },
};
