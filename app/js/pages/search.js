"use strict";
// Search: the query lives in the route (#/search?q=…), so back/forward and
// re-opening the page show the same results. Requests only run on Enter.
// When a search finds nothing (e.g. a typo), the module is asked again with
// relaxed terms and its real results are ranked by similarity ("Meintest du …?").

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function bigrams(text) {
  const counts = new Map();
  const padded = ` ${text} `;
  for (let i = 0; i < padded.length - 1; i += 1) {
    const gram = padded.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

function dice(a, b) {
  const first = bigrams(a);
  const second = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [gram, count] of first) {
    overlap += Math.min(count, second.get(gram) || 0);
    total += count;
  }
  for (const count of second.values()) total += count;
  return total ? (2 * overlap) / total : 0;
}

// 0…1: how well a title matches what the user typed. Compares against the
// title's first words (as many as the query has) and against the whole title.
function titleSimilarity(query, title) {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  const head = t.split(" ").slice(0, q.split(" ").length).join(" ");
  const typo = 1 - levenshtein(q, head) / Math.max(q.length, head.length);
  return Math.max(typo, dice(q, head) * 0.95, dice(q, t) * 0.9);
}

// Broader search terms for a query without results: its longest words and the
// beginning of the longest word. At most three extra requests.
function relaxedQueries(query) {
  const normalized = normalizeTitle(query);
  const words = [...new Set(normalized.split(" ").filter((w) => w.length >= 3))].sort((a, b) => b.length - a.length);
  const queries = words.length > 1 ? words.slice(0, 2) : [];
  if (words[0] && words[0].length >= 5) queries.push(words[0].slice(0, 3));
  return [...new Set(queries)].filter((q) => q !== normalized).slice(0, 3);
}

// "One Piece Log: Fish-Man Island Saga" for "one pice" → "One Piece".
function suggestionFrom(query, title) {
  const count = normalizeTitle(query).split(" ").length;
  return String(title)
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean)
    .slice(0, count)
    .join(" ");
}

const SearchPage = {
  render(view, params) {
    const moduleName = currentModule();
    const query = String(params.q || "").trim();
    const input = h("input", {
      class: "search-input",
      type: "search",
      placeholder: "Titel eingeben und Enter drücken …",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Anime suchen",
    });
    input.value = query;
    const submit = h("button", { class: "button button-primary search-submit", type: "submit" }, icon("search"), h("span", { text: "Suchen" }));
    const form = h("form", { class: "search-bar", role: "search" },
      h("span", { class: "search-bar-icon" }, icon("search")), input, submit);
    const results = h("div", { class: "search-results" });

    view.append(h("div", { class: "page page-search page-inner" },
      pageHeader("Suche", `Durchsucht ${moduleName}. Andere Quellen wählst du oben rechts.`),
      form,
      results));

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      if (value === query) SearchPage.run(results, moduleName, value, submit);
      else go("search", { q: value });
    });

    if (query) {
      SearchPage.run(results, moduleName, query, submit);
    } else {
      SearchPage.renderRecent(results);
      const off = onLibraryChange(() => SearchPage.renderRecent(results));
      requestAnimationFrame(() => input.focus());
      return off;
    }
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
    return null;
  },

  renderRecent(container) {
    const recent = App.library.recentSearches;
    if (!recent.length) {
      container.replaceChildren(emptyState({
        icon: "search",
        title: "Wonach suchst du?",
        text: "Gib einen Anime-Titel ein, z. B. „Frieren“ oder „One Piece“, und drücke Enter.",
      }));
      return;
    }
    container.replaceChildren(h("section", { class: "recent-searches" },
      h("header", { class: "row-header" },
        h("h2", { class: "row-title", text: "Letzte Suchen" }),
        h("button", {
          class: "row-link", type: "button",
          onClick: () => api.library.clearRecentSearches().catch(() => {}),
        }, "Verlauf leeren")),
      h("div", { class: "chip-list" }, recent.map((q) =>
        h("a", { class: "chip chip-button", href: routeHref("search", { q }) }, icon("history"), h("span", { text: q }))))));
  },

  async run(container, moduleName, query, submit) {
    container.replaceChildren(
      h("p", { class: "results-summary loading", text: `Suche nach „${query}“ …` }),
      skeletonGrid(12));
    submit.disabled = true;
    try {
      const items = await api.search(moduleName, query);
      if (!container.isConnected) return;
      const list = (Array.isArray(items) ? items : []).filter((item) => item && item.href && item.title);
      if (!list.length) {
        const shown = await SearchPage.similar(container, moduleName, query);
        if (shown || !container.isConnected) return;
        container.replaceChildren(emptyState({
          icon: "search",
          title: "Keine Ergebnisse gefunden",
          text: `Für „${query}“ gibt es in ${moduleName} keine Treffer – auch keine ähnlichen Titel. Prüfe die Schreibweise oder versuche eine andere Quelle.`,
        }));
        return;
      }
      container.replaceChildren(
        h("p", { class: "results-summary", text: `${list.length} ${list.length === 1 ? "Ergebnis" : "Ergebnisse"} für „${query}“` }),
        grid(list.map((item) => animeCard(moduleName, item))));
    } catch (error) {
      if (!container.isConnected) return;
      container.replaceChildren(errorState({
        title: "Die Suche ist fehlgeschlagen",
        text: errorText(error),
        onRetry: () => SearchPage.run(container, moduleName, query, submit),
      }));
    } finally {
      submit.disabled = false;
    }
  },

  // Returns true when similar titles were shown.
  async similar(container, moduleName, query) {
    const queries = relaxedQueries(query);
    if (!queries.length) return false;
    container.replaceChildren(
      h("p", { class: "results-summary loading", text: `Keine exakten Treffer für „${query}“ – suche ähnliche Titel …` }),
      skeletonGrid(6));
    const answers = await Promise.allSettled(queries.map((q) => api.search(moduleName, q, { remember: false })));
    if (!container.isConnected) return true;

    const seen = new Set();
    const scored = [];
    for (const answer of answers) {
      if (answer.status !== "fulfilled" || !Array.isArray(answer.value)) continue;
      for (const item of answer.value) {
        if (!item?.href || !item.title || seen.has(item.href)) continue;
        seen.add(item.href);
        const score = titleSimilarity(query, item.title);
        if (score >= 0.55) scored.push({ item, score });
      }
    }
    if (!scored.length) return false;
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    // 0.70 still catches two typos in a short word ("Frirn" → Frieren: 0.71)
    // while unrelated titles stay below ("One Pice" → One-Punch Man: 0.67).
    const suggestion = best.score >= 0.7 ? suggestionFrom(query, best.item.title) : "";
    const offerSuggestion = suggestion && normalizeTitle(suggestion) !== normalizeTitle(query);
    const shown = scored.slice(0, 24);
    container.replaceChildren(
      h("div", { class: "did-you-mean" },
        h("p", { class: "did-you-mean-text", text: `Keine exakten Treffer für „${query}“.` }),
        offerSuggestion
          ? h("a", { class: "did-you-mean-link", href: routeHref("search", { q: suggestion }) }, "Meintest du ", h("strong", { text: suggestion }), "?")
          : null),
      h("p", { class: "results-summary", text: `${shown.length} ähnliche${shown.length === 1 ? "r Titel" : " Titel"}` }),
      grid(shown.map(({ item }) => animeCard(moduleName, item))));
    return true;
  },
};
