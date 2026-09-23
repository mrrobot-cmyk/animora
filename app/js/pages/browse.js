"use strict";
// Entdecken: the module's browsable feeds (discoveryFeed) with paging. Tabs
// come from the module's own discovery data, nothing is invented.

async function browseFeeds(moduleName) {
  const module = App.modules.find((m) => m.name === moduleName) || { extraFeeds: [] };
  let discovery = await api.cachedDiscovery(moduleName).catch(() => null);
  if (!discovery) discovery = await api.discovery(moduleName);
  const feeds = [];
  const staticSections = [];
  for (const section of discovery?.sections || []) {
    const feedId = section.viewAll?.feedId;
    if (feedId && !feeds.some((f) => f.id === feedId)) feeds.push({ id: feedId, title: sectionTitle(section.title) });
    else if (!feedId && section.items?.length) staticSections.push({ id: `section:${section.id}`, title: sectionTitle(section.title), items: section.items });
  }
  for (const extra of module.extraFeeds || []) {
    if (!feeds.some((f) => f.id === extra.id)) feeds.push(extra);
  }
  return [...feeds, ...staticSections];
}

const BrowsePage = {
  render(view, params) {
    const moduleName = currentModule();
    const tabs = h("div", { class: "tabs", role: "tablist" });
    const content = h("div", { class: "browse-content" }, skeletonGrid(18));
    view.append(h("div", { class: "page page-browse page-inner" },
      pageHeader("Entdecken", `Kataloge von ${moduleName}`),
      tabs,
      content));

    let disposed = false;
    const load = async () => {
      content.replaceChildren(skeletonGrid(18));
      let feeds;
      try {
        feeds = await browseFeeds(moduleName);
      } catch (error) {
        if (!disposed) content.replaceChildren(errorState({ title: "Katalog konnte nicht geladen werden", text: errorText(error), onRetry: load }));
        return;
      }
      if (disposed) return;
      if (!feeds.length) {
        content.replaceChildren(emptyState({ icon: "compass", title: "Keine Kataloge verfügbar", text: `${moduleName} bietet keine durchsuchbaren Listen an. Nutze die Suche.` }));
        return;
      }
      const active = feeds.find((f) => f.id === params.feed) || feeds[0];
      tabs.replaceChildren(...feeds.map((feed) => h("a", {
        class: `tab ${feed === active ? "active" : ""}`,
        role: "tab",
        "aria-selected": String(feed === active),
        href: routeHref("browse", { feed: feed.id }),
      }, feed.title)));
      if (active.items) {
        content.replaceChildren(grid(active.items.map((item) => animeCard(moduleName, item))));
      } else {
        BrowsePage.loadFeed(content, moduleName, active.id, () => disposed);
      }
    };
    load();
    return () => { disposed = true; };
  },

  loadFeed(content, moduleName, feedId, isDisposed) {
    const cards = grid([]);
    const seen = new Set();
    const more = h("button", { class: "button button-secondary load-more", type: "button" }, h("span", { text: "Mehr laden" }));
    const footer = h("div", { class: "load-more-row" });
    content.replaceChildren(cards, footer);
    let page = 0;

    const loadPage = async () => {
      const next = page + 1;
      more.disabled = true;
      setChildren(footer, page ? more : null);
      if (page) more.replaceChildren(h("span", { class: "spinner" }), h("span", { text: "Lädt …" }));
      else cards.replaceChildren(...skeletonCards(18));
      try {
        const result = await api.feed(moduleName, feedId, next);
        if (isDisposed()) return;
        if (!page) cards.replaceChildren();
        const items = (result?.items || []).filter((item) => item.href && item.title && !seen.has(item.href));
        items.forEach((item) => seen.add(item.href));
        cards.append(...items.map((item) => animeCard(moduleName, item)));
        page = next;
        if (!cards.children.length) {
          content.replaceChildren(emptyState({ icon: "compass", title: "Diese Liste ist leer", text: "Die Quelle liefert hier derzeit keine Titel." }));
          return;
        }
        more.replaceChildren(h("span", { text: "Mehr laden" }));
        more.disabled = false;
        footer.replaceChildren(result?.hasMore && items.length ? more : h("p", { class: "list-end", text: "Ende der Liste" }));
      } catch (error) {
        if (isDisposed()) return;
        if (!page) {
          content.replaceChildren(errorState({ title: "Liste konnte nicht geladen werden", text: errorText(error), onRetry: () => BrowsePage.loadFeed(content, moduleName, feedId, isDisposed) }));
        } else {
          more.replaceChildren(h("span", { text: "Erneut versuchen" }));
          more.disabled = false;
          toast(`Weitere Titel konnten nicht geladen werden. ${errorText(error)}`, "error");
        }
      }
    };
    more.addEventListener("click", loadPage);
    loadPage();
  },
};
