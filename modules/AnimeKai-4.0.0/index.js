(() => {
  'use strict';

  const MODULE_NAME = 'AnimeKai';
  const BASE_URL = 'https://animekai.be';
  const MEGA_ORIGIN = 'https://megaplay.buzz';
  const MAX_EPISODES = 2000;
  const PAGE_FETCH_TIMEOUT_MS = 9000;
  const EMBED_TIMEOUT_MS = 8000;
  const STREAM_DEADLINE_MS = 22000;

  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  const defaultHeaders = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    Referer: BASE_URL + '/',
    Origin: BASE_URL,
  };

  const HLS_HEADERS = {
    'User-Agent': USER_AGENT,
    Referer: MEGA_ORIGIN + '/',
    Origin: MEGA_ORIGIN,
    Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp4,*/*',
  };

  const searchCache = {};
  const watchCache = {};
  const sourcesCache = {};
  let homeHtmlCache = { at: 0, body: '' };

  function log(msg) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(msg || ''));
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, Math.max(1, Number(ms) || 0));
    });
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return Promise.race([promise, sleep(waitMs).then(function () { return fallback; })]);
  }

  function decodeHtml(str) {
    return String(str || '')
      .replace(/\\u([0-9a-f]{4})/gi, function (_, h) {
        return String.fromCharCode(parseInt(h, 16));
      })
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#038;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/^"|"$/g, '')
      .trim();
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function isResponseOk(res, status) {
    if (res && (res.ok === true || res.ok === 1)) return true;
    if (res && (res.ok === false || res.ok === 0)) return false;
    return status >= 200 && status < 300;
  }

  async function readResponseBody(res) {
    if (!res) return '';
    if (res.json !== undefined && res.json !== null && typeof res.json !== 'function') {
      try {
        return JSON.stringify(res.json);
      } catch (_) {}
    }
    if (typeof res.body === 'string' && res.body.length) return res.body;
    if (typeof res.text === 'function') {
      try {
        const text = await res.text();
        return typeof text === 'string' ? text : '';
      } catch (_) {
        return '';
      }
    }
    return '';
  }

  async function readResponseJson(res, textBody) {
    if (res && res.json !== undefined && res.json !== null && typeof res.json !== 'function') {
      return res.json;
    }
    let json = safeJsonParse(textBody);
    if (json != null) return json;
    if (res && typeof res.json === 'function') {
      try {
        json = await res.json();
        if (json != null) return json;
      } catch (_) {}
    }
    return null;
  }

  function headerMap(headers) {
    const out = {};
    if (!headers) return out;
    if (typeof headers.forEach === 'function') {
      headers.forEach(function (value, key) {
        out[String(key).toLowerCase()] = value;
      });
      return out;
    }
    const keys = Object.keys(headers);
    for (let i = 0; i < keys.length; i += 1) {
      out[String(keys[i]).toLowerCase()] = headers[keys[i]];
    }
    return out;
  }

  async function request(url, options) {
    const cfg = options || {};
    const method = cfg.method || 'GET';
    const headers = Object.assign({}, defaultHeaders, cfg.headers || {});
    let body = cfg.body == null ? null : cfg.body;
    if (body && typeof body === 'object') {
      body = JSON.stringify(body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
    const fetchOpts = {};
    if (cfg.followRedirects === false) fetchOpts.followRedirects = false;

    const attempts = cfg.retries == null ? 2 : Math.max(1, Number(cfg.retries) || 1);
    let last = { ok: false, status: 0, body: '', json: null, headers: {}, finalUrl: '' };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (attempt > 0) await sleep(700 * attempt);
        if (typeof fetchv2 === 'function') {
          const res = await fetchv2(url, headers, method, body, fetchOpts);
          const status = Number((res && res.status) || 0);
          const textBody = await readResponseBody(res);
          last = {
            ok: isResponseOk(res, status),
            status: status,
            body: textBody,
            json: await readResponseJson(res, textBody),
            headers: headerMap(res && res.headers),
            finalUrl: (res && res.finalUrl) || '',
          };
        } else if (typeof fetch === 'function') {
          const res = await fetch(url, {
            method: method,
            headers: headers,
            body: body,
            redirect: cfg.followRedirects === false ? 'manual' : 'follow',
          });
          const textBody = await res.text();
          last = {
            ok: !!res.ok,
            status: Number(res.status || 0),
            body: textBody,
            json: safeJsonParse(textBody),
            headers: headerMap(res.headers),
            finalUrl: res.url || '',
          };
        } else {
          return last;
        }
        if (last.ok) return last;
        if (last.status !== 429 && last.status !== 503 && last.status !== 0) return last;
      } catch (error) {
        log('request error: ' + (error && error.message ? error.message : String(error)));
        last = { ok: false, status: 0, body: '', json: null, headers: {}, finalUrl: '' };
      }
    }
    return last;
  }

  function slugify(query) {
    return String(query || '')
      .trim()
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[’'`´]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function normForMatch(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[’'`´:;.!?&,+()\[\]{}<>/\\|–—"]/g, ' ')
      .replace(/[\u2010-\u2015\u00b7]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compactForMatch(value) {
    return normForMatch(value).replace(/[^a-z0-9]/g, '');
  }

  function absoluteUrl(maybe) {
    const value = String(maybe || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('//')) return 'https:' + value;
    if (value.charAt(0) === '/') return BASE_URL + value;
    return BASE_URL + '/' + value;
  }

  function watchUrl(slug) {
    const key = String(slug || '').trim().replace(/^\/+/, '');
    if (!key) return '';
    return BASE_URL + '/watch/' + key;
  }

  function episodeUrl(slug, number) {
    const n = Math.max(1, Number(number) || 1);
    return watchUrl(slug) + '/ep-' + n;
  }

  function parseHref(href) {
    const raw = String(href || '').trim();
    if (!raw) return { slug: '', ep: 0 };
    if (raw.charAt(0) === '{') {
      const json = safeJsonParse(raw);
      if (json && (json.slug || json.href)) return parseHref(json.slug || json.href);
    }
    const cleaned = raw.replace(/^https?:\/\/[^/]+/i, '').split('?')[0].split('#')[0];
    const watchMatch = cleaned.match(/\/watch\/([a-z0-9][a-z0-9-]*)(?:\/ep-(\d+))?/i);
    if (watchMatch) {
      return { slug: watchMatch[1].toLowerCase(), ep: Number(watchMatch[2] || 0) };
    }
    if (/^[a-z0-9][a-z0-9-]*$/i.test(raw)) {
      return { slug: raw.toLowerCase(), ep: 0 };
    }
    const tail = cleaned.replace(/^\/+/, '').split('/')[0];
    if (/^[a-z0-9][a-z0-9-]*$/i.test(tail)) {
      return { slug: tail.toLowerCase(), ep: 0 };
    }
    return { slug: '', ep: 0 };
  }

  function attr(tag, name) {
    const re = new RegExp('\\b' + name + '=["\']([^"\']*)["\']', 'i');
    const match = re.exec(String(tag || ''));
    return match ? decodeHtml(match[1]) : '';
  }

  function typeFromInfo(html) {
    const block = String(html || '');
    const bold = block.match(/<span><b>([^<]+)<\/b><\/span>/i);
    if (bold) {
      const value = decodeHtml(bold[1]).toLowerCase();
      if (/^(tv|movie|ona|ova|special|music|cm)$/i.test(value)) return value;
    }
    if (/\bMOVIE\b/i.test(block)) return 'movie';
    if (/\bOVA\b/i.test(block)) return 'ova';
    if (/\bONA\b/i.test(block)) return 'ona';
    if (/\bSPECIAL\b/i.test(block)) return 'special';
    if (/\bTV\b/i.test(block)) return 'tv';
    return '';
  }

  function cardFromParts(slug, title, image, extra) {
    const key = String(slug || '').trim();
    const name = decodeHtml(title);
    if (!key || !name) return null;
    const item = {
      href: watchUrl(key),
      title: name,
      image: absoluteUrl(image),
      slug: key,
      type: extra && extra.type ? String(extra.type).toLowerCase() : '',
      epCount: extra && extra.epCount ? Number(extra.epCount) || 0 : 0,
      hasSub: !!(extra && extra.hasSub),
      hasDub: !!(extra && extra.hasDub),
    };
    return item;
  }

  function parseAitemCards(html) {
    const cards = [];
    const seen = {};
    const source = String(html || '');

    const blockRe = /<div class="aitem"[\s\S]*?<\/div>\s*<\/div>/gi;
    let block = blockRe.exec(source);
    while (block) {
      const chunk = block[0];
      const href = attr(chunk.match(/<a[^>]*href=["'][^"']+["'][^>]*>/i), 'href') ||
        (chunk.match(/href=["']([^"']*\/watch\/[^"']+)["']/i) || [])[1] || '';
      const parsed = parseHref(href);
      const title =
        attr((chunk.match(/<a class="title"[^>]*>/i) || [''])[0], 'title') ||
        decodeHtml((chunk.match(/<a class="title"[^>]*>([^<]+)/i) || [])[1] || '') ||
        attr((chunk.match(/<img\b[^>]*>/i) || [''])[0], 'alt');
      const image =
        attr((chunk.match(/<img\b[^>]*>/i) || [''])[0], 'src') ||
        ((chunk.match(/background-image:url\(['"]?([^'")]+)['"]?\)/i) || [])[1] || '');
      const type = typeFromInfo(chunk);
      const subMatch = chunk.match(/class="sub"[^>]*>[\s\S]*?<\/svg>\s*(\d+)/i);
      const dubMatch = chunk.match(/class="dub"[^>]*>[\s\S]*?<\/svg>\s*(\d+)/i);
      const epCount = Math.max(
        subMatch ? Number(subMatch[1]) || 0 : 0,
        dubMatch ? Number(dubMatch[1]) || 0 : 0,
      );
      const card = cardFromParts(parsed.slug, title, image, {
        type: type,
        epCount: epCount,
        hasSub: !!subMatch,
        hasDub: !!dubMatch,
      });
      if (card && !seen[card.slug]) {
        seen[card.slug] = true;
        cards.push(card);
      }
      block = blockRe.exec(source);
    }

    const miniRe = /<a class="aitem"[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']+)["'][\s\S]*?<\/a>/gi;
    let mini = miniRe.exec(source);
    while (mini) {
      const parsed = parseHref(mini[1]);
      const image = ((mini[0].match(/<img\b[^>]*src=["']([^"']+)["']/i) || [])[1] || '');
      const type = typeFromInfo(mini[0]);
      const card = cardFromParts(parsed.slug, mini[2], image, { type: type });
      if (card && !seen[card.slug]) {
        seen[card.slug] = true;
        cards.push(card);
      }
      mini = miniRe.exec(source);
    }

    const trendRe = /<div class="aitem"[^>]*style="background-image:url\('([^']+)'\)[\s\S]*?<a class="title" href="([^"]+)">([\s\S]*?)<\/a>/gi;
    let trend = trendRe.exec(source);
    while (trend) {
      const parsed = parseHref(trend[2]);
      const card = cardFromParts(parsed.slug, trend[3], trend[1], { type: 'tv' });
      if (card && !seen[card.slug]) {
        seen[card.slug] = true;
        cards.push(card);
      }
      trend = trendRe.exec(source);
    }

    return cards;
  }

  function parseFeaturedCards(html) {
    const cards = [];
    const seen = {};
    const re = /<div class="swiper-slide"[^>]*style="background-image:url\('([^']+)'\)[\s\S]*?<p class="title"[^>]*>([\s\S]*?)<\/p>[\s\S]*?href="([^"]*\/watch\/[^"]+)"/gi;
    let match = re.exec(String(html || ''));
    while (match) {
      const parsed = parseHref(match[3]);
      const card = cardFromParts(parsed.slug, match[2], match[1], { type: 'tv' });
      if (card && !seen[card.slug]) {
        seen[card.slug] = true;
        cards.push(card);
      }
      match = re.exec(String(html || ''));
    }
    return cards;
  }

  function publicCard(item) {
    if (!item || !item.href || !item.title) return null;
    return {
      href: item.href,
      title: item.title,
      image: item.image || '',
    };
  }

  function uniquePublic(items, limit, used) {
    const out = [];
    const seen = used || {};
    for (let i = 0; i < (items || []).length; i += 1) {
      const card = publicCard(items[i]);
      if (!card || !card.href || seen[card.href]) continue;
      if (!card.image) continue;
      seen[card.href] = true;
      out.push(card);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  function queryVariants(query) {
    const q = String(query || '').trim();
    const lower = q.toLowerCase();
    const out = [q];
    const aliases = {
      'steins gate': ['steins;gate', 'steinsgate'],
      'dr stone': ['dr. stone'],
      'fullmetal alchemist brotherhood': [
        'fullmetal alchemist: brotherhood',
        'fullmetal alchemist',
      ],
      'hunter x hunter': ['hunter x hunter'],
      'one punch man': ['one-punch man'],
      'mob psycho 100': ['mob psycho 100'],
      'attack on titan': ['shingeki no kyojin'],
      'fma brotherhood': ['fullmetal alchemist: brotherhood'],
    };
    const extra = aliases[lower] || [];
    for (let i = 0; i < extra.length; i += 1) out.push(extra[i]);
    if (lower.indexOf('.') < 0 && /\bdr\b/i.test(q)) {
      out.push(q.replace(/\bdr\b/i, 'dr.'));
    }
    if (lower.indexOf(';') < 0 && /\bgate\b/i.test(lower)) {
      out.push(q.replace(/\s+gate/i, ';gate'));
    }
    const uniq = [];
    const seen = {};
    for (let i = 0; i < out.length; i += 1) {
      const key = String(out[i] || '').toLowerCase();
      if (!key || seen[key]) continue;
      seen[key] = true;
      uniq.push(out[i]);
    }
    return uniq;
  }

  function rankSearchItem(item, query) {
    const q = String(query || '').trim();
    const slugQ = slugify(q);
    const normQ = normForMatch(q);
    const compactQ = compactForMatch(q);
    const title = decodeHtml((item && item.title) || '');
    const titleNorm = normForMatch(title);
    const titleCompact = compactForMatch(title);
    const slug = String((item && item.slug) || '').toLowerCase();
    const type = String((item && item.type) || '').toLowerCase();
    const epCount = Number((item && item.epCount) || 0);
    const isMovieLike = type === 'movie' || type === 'special' || type === 'cm' || type === 'music';
    const isSeries = type === 'tv' || type === 'ona' || type === 'ova' || !type;

    if (!q) return 8;
    if (titleNorm === normQ || titleCompact === compactQ) {
      if (isSeries) return 0;
      return 4;
    }
    if (slug === slugQ) return isSeries ? 1 : 5;
    if (compactQ && titleCompact === compactQ + '0') return 6;
    if (isSeries && titleNorm.indexOf(normQ + ' ') === 0 && epCount >= 12) return 7;
    if (isSeries && titleCompact.indexOf(compactQ) === 0) return 8;
    if (isSeries && titleCompact.indexOf(compactQ) >= 0) return 9;
    if (isMovieLike && (titleNorm === normQ || slug === slugQ)) return 10;
    if (titleNorm.indexOf(normQ) >= 0) return isMovieLike ? 14 : 11;
    if (slug.indexOf(slugQ) >= 0) return isMovieLike ? 15 : 12;
    return 20;
  }

  function sortSearchItems(items, query) {
    const ranked = [];
    const seen = {};
    for (let i = 0; i < (items || []).length; i += 1) {
      const item = items[i];
      const slug = String((item && item.slug) || '').trim();
      if (!slug || seen[slug]) continue;
      seen[slug] = true;
      ranked.push({
        item: item,
        rank: rankSearchItem(item, query),
        epCount: Number((item && item.epCount) || 0),
        slugLen: slug.length,
      });
    }
    ranked.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.epCount !== b.epCount) return b.epCount - a.epCount;
      return a.slugLen - b.slugLen;
    });
    const out = [];
    for (let i = 0; i < ranked.length && out.length < 30; i += 1) {
      const card = publicCard(ranked[i].item);
      if (card) out.push(card);
    }
    return out;
  }

  async function fetchHomeHtml() {
    const now = Date.now();
    if (homeHtmlCache.body && now - homeHtmlCache.at < 120000) return homeHtmlCache.body;
    const res = await settleWithin(
      request(BASE_URL + '/home', { headers: { Accept: 'text/html' } }),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    const body = res && res.ok ? String(res.body || '') : '';
    if (body) homeHtmlCache = { at: now, body: body };
    return body;
  }

  async function fetchWatchHtml(slug) {
    const key = String(slug || '').trim();
    if (!key) return '';
    if (watchCache[key]) return watchCache[key];
    const res = await settleWithin(
      request(watchUrl(key), { headers: { Accept: 'text/html' } }),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    if (!res || !res.ok || !res.body) return '';
    watchCache[key] = String(res.body);
    return watchCache[key];
  }

  function suggestItemToCard(item) {
    if (!item) return null;
    const slug = String(item.slug || '').trim();
    return cardFromParts(slug, item.title || item.title_jp, item.poster_url, {
      type: String(item.type || '').toLowerCase(),
      epCount: Number(item.ep_count || item.sub_count || item.dub_count || 0),
      hasSub: !!item.has_sub,
      hasDub: !!item.has_dub,
    });
  }

  async function fetchSuggest(query) {
    const res = await settleWithin(
      request(BASE_URL + '/api/search/suggest?q=' + encodeURIComponent(query), {
        headers: { Accept: 'application/json', Referer: BASE_URL + '/' },
      }),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    const rows = res && Array.isArray(res.json) ? res.json : [];
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
      const card = suggestItemToCard(rows[i]);
      if (card) out.push(card);
    }
    return out;
  }

  async function fetchBrowse(query) {
    const url = BASE_URL + '/browse?keyword=' + encodeURIComponent(query);
    const res = await settleWithin(
      request(url, { headers: { Accept: 'text/html' } }),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    if (!res || !res.ok) return [];
    return parseAitemCards(res.body || '');
  }

  async function fetchAjaxUpdates(tab, page) {
    const res = await settleWithin(
      request(
        BASE_URL + '/ajax/home/items?tab=' + encodeURIComponent(tab || 'all-updates') +
          '&page=' + Math.max(1, Number(page) || 1),
        {
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: BASE_URL + '/',
          },
        },
      ),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    const json = res && res.json;
    const html = json && typeof json.html === 'string' ? json.html : '';
    return {
      items: parseAitemCards(html),
      page: Number((json && json.page) || page || 1),
      hasMore: !!(json && json.has_next),
    };
  }

  async function fetchListingPage(path, page) {
    const suffix = page && Number(page) > 1 ? ((path.indexOf('?') >= 0 ? '&' : '?') + 'page=' + Number(page)) : '';
    const res = await settleWithin(
      request(BASE_URL + path + suffix, { headers: { Accept: 'text/html' } }),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    if (!res || !res.ok) return [];
    return parseAitemCards(res.body || '');
  }

  function detailsFromHtml(html, slug) {
    const source = String(html || '');
    if (!source) return null;
    const titleMatch = source.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
      source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = decodeHtml(titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '') : '');
    if (!title) return null;
    const descMatch = source.match(/id="synopsis-text"[^>]*>([\s\S]*?)<\/div>/i);
    const imageMatch =
      source.match(/<div class="poster">[\s\S]*?<img[^>]*src=["']([^"']+)["']/i) ||
      source.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const statusMatch = source.match(/Status:\s*<span>([^<]+)<\/span>/i);
    const epMatch = source.match(/Episodes:\s*<span>([^<]+)<\/span>/i);
    const genres = [];
    const genreRe = /\/genres\/[^"]+"[^>]*>([^<]+)/gi;
    let genreHit = genreRe.exec(source);
    while (genreHit) {
      genres.push(decodeHtml(genreHit[1]));
      genreHit = genreRe.exec(source);
    }
    return {
      title: title,
      description: decodeHtml((descMatch ? descMatch[1] : '').replace(/<[^>]+>/g, ' ')),
      image: absoluteUrl(imageMatch ? imageMatch[1] : ''),
      href: watchUrl(slug),
      status: decodeHtml(statusMatch ? statusMatch[1] : ''),
      episodes: decodeHtml(epMatch ? epMatch[1] : ''),
      genres: genres,
    };
  }

  async function slugFallbackCard(query) {
    const tries = [];
    const hyphen = slugify(query);
    const compact = compactForMatch(query);
    if (hyphen) tries.push(hyphen);
    if (compact && compact !== hyphen) tries.push(compact);
    const aliases = {
      'steins-gate': 'steinsgate',
      'fullmetal-alchemist-brotherhood': 'fullmetal-alchemist',
    };
    if (aliases[hyphen]) tries.push(aliases[hyphen]);
    const seen = {};
    for (let i = 0; i < tries.length; i += 1) {
      const slug = tries[i];
      if (!slug || seen[slug]) continue;
      seen[slug] = true;
      const html = await fetchWatchHtml(slug);
      if (!html) continue;
      const details = detailsFromHtml(html, slug);
      if (!details || !details.title) continue;
      return cardFromParts(slug, details.title, details.image, {
        type: 'tv',
        epCount: Number(details.episodes) || 0,
        hasSub: true,
      });
    }
    return null;
  }

  async function searchByQuery(query) {
    const q = String(query || '').trim();
    if (!q) {
      const latest = await fetchAjaxUpdates('all-updates', 1);
      return uniquePublic(latest.items || [], 30, {});
    }
    if (searchCache[q.toLowerCase()]) return searchCache[q.toLowerCase()];

    const variants = queryVariants(q);
    const merged = [];
    const seen = {};
    for (let i = 0; i < variants.length; i += 1) {
      const pair = await Promise.all([fetchSuggest(variants[i]), fetchBrowse(variants[i])]);
      const batch = (pair[0] || []).concat(pair[1] || []);
      for (let j = 0; j < batch.length; j += 1) {
        const item = batch[j];
        if (!item || !item.slug || seen[item.slug]) continue;
        seen[item.slug] = true;
        merged.push(item);
      }
      const hasExact = merged.some(function (item) {
        return rankSearchItem(item, q) <= 1;
      });
      if (hasExact) break;
    }

    const rankedPreview = merged.map(function (item) {
      return rankSearchItem(item, q);
    });
    const hasExact = rankedPreview.some(function (rank) { return rank <= 1; });
    if (!hasExact) {
      const extra = await slugFallbackCard(q);
      if (extra && extra.slug && !seen[extra.slug]) merged.unshift(extra);
    }

    const out = sortSearchItems(merged, q);
    searchCache[q.toLowerCase()] = out;
    return out;
  }

  async function searchResults(query) {
    try {
      return await searchByQuery(query);
    } catch (error) {
      log('search error: ' + (error && error.message ? error.message : String(error)));
      return [];
    }
  }

  async function extractDetails(urlOrId) {
    try {
      const parsed = parseHref(urlOrId);
      if (!parsed.slug) return { title: '', description: '' };
      const html = await fetchWatchHtml(parsed.slug);
      const details = detailsFromHtml(html, parsed.slug);
      if (details) return details;
      return { title: parsed.slug, description: '', href: watchUrl(parsed.slug) };
    } catch (error) {
      log('details error: ' + (error && error.message ? error.message : String(error)));
      return { title: '', description: '' };
    }
  }

  function parseEpisodeList(html, slug) {
    const episodes = [];
    const seen = {};
    const re = /<a\b([^>]*\bnum=["'](\d+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let match = re.exec(String(html || ''));
    while (match && episodes.length < MAX_EPISODES) {
      const attrs = match[1] || '';
      const number = Number(match[2] || 0);
      if (!number || seen[number]) {
        match = re.exec(String(html || ''));
        continue;
      }
      seen[number] = true;
      const href = attr(attrs, 'href') || episodeUrl(slug, number);
      const title = decodeHtml(String(match[3] || '').replace(/<[^>]+>/g, ' '));
      const subFlag = attr(attrs, 'data-sub');
      const dubFlag = attr(attrs, 'data-dub');
      episodes.push({
        number: number,
        href: absoluteUrl(href) || episodeUrl(slug, number),
        title: title.replace(/^\d+\s*/, '').trim() || ('Episode ' + number),
        subAvailable: subFlag === '' ? true : subFlag === '1',
        dubAvailable: dubFlag === '1',
      });
      match = re.exec(String(html || ''));
    }
    episodes.sort(function (a, b) { return a.number - b.number; });
    return episodes;
  }

  async function extractEpisodes(seriesId) {
    try {
      const parsed = parseHref(seriesId);
      if (!parsed.slug) return [];
      const html = await fetchWatchHtml(parsed.slug);
      return parseEpisodeList(html, parsed.slug);
    } catch (error) {
      log('episodes error: ' + (error && error.message ? error.message : String(error)));
      return [];
    }
  }

  function isFakeHost(url) {
    return /tiktokcdn|ibyteimg|ad-site|doubleclick|googlesyndication/i.test(String(url || ''));
  }

  function pickLangSources(sources, wantDub) {
    const groups = sources && typeof sources === 'object' ? sources : {};
    if (wantDub) return Array.isArray(groups.dub) ? groups.dub : [];
    const order = ['sub', 'h-sub', 'softsub'];
    for (let i = 0; i < order.length; i += 1) {
      if (Array.isArray(groups[order[i]]) && groups[order[i]].length) return groups[order[i]];
    }
    return [];
  }

  async function fetchSourcesJson(slug, ep) {
    const key = slug + ':' + ep;
    if (sourcesCache[key]) return sourcesCache[key];
    const res = await settleWithin(
      request(BASE_URL + '/watch/' + encodeURIComponent(slug) + '/ep/' + ep + '/sources', {
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: episodeUrl(slug, ep),
        },
      }),
      EMBED_TIMEOUT_MS,
      null,
    );
    const json = res && res.json;
    if (!json || typeof json !== 'object') return null;
    sourcesCache[key] = json;
    return json;
  }

  function uniqueSourceUrls(rows) {
    const out = [];
    const seen = {};
    for (let i = 0; i < (rows || []).length; i += 1) {
      const url = String((rows[i] && rows[i].source_url) || '').trim();
      if (!url || seen[url]) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      if (isFakeHost(url)) continue;
      seen[url] = true;
      out.push(url);
    }
    out.sort(function (a, b) {
      const aMega = /megaplay\.buzz/i.test(a) ? 0 : 1;
      const bMega = /megaplay\.buzz/i.test(b) ? 0 : 1;
      return aMega - bMega;
    });
    return out;
  }

  const ONEANIME_HEADERS = {
    'User-Agent': USER_AGENT,
    Referer: 'https://my.1anime.site/',
    Origin: 'https://my.1anime.site',
    Accept: '*/*',
  };

  async function unwrapOneAnime(embedUrl) {
    const pageRes = await settleWithin(
      request(embedUrl, {
        headers: { Accept: 'text/html,*/*', Referer: BASE_URL + '/' },
      }),
      EMBED_TIMEOUT_MS,
      null,
    );
    if (!pageRes || !pageRes.ok || !pageRes.body) return null;
    const sourceMatch = String(pageRes.body).match(
      /<source[^>]+src=["'](https?:\/\/[^"']+)["']/i,
    ) || String(pageRes.body).match(/(https?:\/\/my\.1anime\.site\/stream\/[a-z0-9]+)/i);
    const streamHref = sourceMatch ? sourceMatch[1] : '';
    if (!streamHref) return null;
    const redirect = await settleWithin(
      request(streamHref, {
        followRedirects: false,
        headers: Object.assign({}, ONEANIME_HEADERS, { Range: 'bytes=0-1' }),
      }),
      EMBED_TIMEOUT_MS,
      null,
    );
    const location = redirect && (redirect.headers.location || redirect.headers.Location);
    let finalUrl = streamHref;
    if (location) {
      finalUrl = /^https?:\/\//i.test(location)
        ? location
        : 'https://my.1anime.site' + (location.charAt(0) === '/' ? location : '/' + location);
    }
    if (!/^https?:\/\//i.test(finalUrl) || isFakeHost(finalUrl)) return null;
    return {
      url: finalUrl,
      streamType: 'mp4',
      subtitles: [],
      headers: ONEANIME_HEADERS,
    };
  }

  async function unwrapEmbed(embedUrl, wantDub) {
    const url = String(embedUrl || '').trim();
    if (!url) return null;
    if (/megaplay\.buzz/i.test(url)) return unwrapMegaPlay(url, wantDub);
    if (/1anime\.site/i.test(url)) return unwrapOneAnime(url);
    const htmlRes = await settleWithin(
      request(url, { headers: { Accept: 'text/html,*/*', Referer: BASE_URL + '/' } }),
      EMBED_TIMEOUT_MS,
      null,
    );
    const html = htmlRes && htmlRes.body ? String(htmlRes.body) : '';
    const m3u8 = html.match(/https?:\/\/[^"'\\\s<>]+\.m3u8(?:\?[^"'\\\s<>]*)?/i);
    const mp4 = html.match(/<source[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (m3u8 && !isFakeHost(m3u8[0])) {
      return {
        url: m3u8[0],
        streamType: 'hls',
        subtitles: [],
        headers: { 'User-Agent': USER_AGENT, Referer: url, Origin: MEGA_ORIGIN },
      };
    }
    if (mp4 && !isFakeHost(mp4[1])) {
      return unwrapOneAnime(url);
    }
    return null;
  }

  function parseMegaPlayId(embedHtml) {
    const match = String(embedHtml || '').match(/\bdata-id=["'](\d+)["']/i);
    return match ? match[1] : '';
  }

  function embedType(embedHtml) {
    const match = String(embedHtml || '').match(/\btype\s*:\s*['"](sub|dub|raw|h-sub)['"]/i);
    return match ? match[1].toLowerCase() : '';
  }

  function trackList(payload) {
    const tracks = payload && Array.isArray(payload.tracks) ? payload.tracks : [];
    const out = [];
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      const file = String((track && (track.file || track.url)) || '').replace(/\\\//g, '/');
      const kind = String((track && track.kind) || 'captions');
      if (!/^https?:\/\//i.test(file)) continue;
      if (kind !== 'captions' && kind !== 'subtitles') continue;
      out.push({
        label: String((track && track.label) || 'Subtitle'),
        url: file,
        file: file,
        language: String((track && (track.lang || track.srclang)) || ''),
        kind: 'captions',
        headers: HLS_HEADERS,
      });
    }
    return out;
  }

  function skipWindow(payload, key) {
    const node = payload && payload[key];
    if (!node || typeof node !== 'object') return null;
    const start = Number(node.start || 0);
    const end = Number(node.end || 0);
    if (!(end > start) || end <= 0) return null;
    return { start: start, end: end };
  }

  async function unwrapMegaPlay(embedUrl, wantDub) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await sleep(500 * attempt);
      const embedRes = await settleWithin(
        request(embedUrl, {
          headers: {
            Accept: 'text/html,*/*',
            Referer: BASE_URL + '/',
          },
        }),
        EMBED_TIMEOUT_MS,
        null,
      );
      if (!embedRes || !embedRes.ok || !embedRes.body) continue;
      const dataId = parseMegaPlayId(embedRes.body);
      if (!dataId) continue;
      const kind = embedType(embedRes.body);
      if (wantDub && kind && kind !== 'dub') return null;
      if (!wantDub && kind === 'dub') return null;

      // data-id is the MegaPlay file id. data-realid / data-mediaid resolve other titles.
      const endpoints = [
        MEGA_ORIGIN + '/stream/getSources?id=' + encodeURIComponent(dataId),
        MEGA_ORIGIN + '/stream/getSourcesNew?id=' + encodeURIComponent(dataId),
      ];
      let best = null;
      for (let i = 0; i < endpoints.length; i += 1) {
        const srcRes = await settleWithin(
          request(endpoints[i], {
            headers: {
              Accept: 'application/json, text/plain, */*',
              Referer: MEGA_ORIGIN + '/',
              Origin: MEGA_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
            },
          }),
          EMBED_TIMEOUT_MS,
          null,
        );
        const json = srcRes && srcRes.json;
        const file = json && json.sources && String(json.sources.file || '').replace(/\\\//g, '/');
        if (!file || !/^https?:\/\//i.test(file) || !/\.m3u8(?:[?#]|$)/i.test(file)) continue;
        if (isFakeHost(file)) continue;
        const candidate = {
          url: file,
          subtitles: trackList(json),
          intro: skipWindow(json, 'intro'),
          outro: skipWindow(json, 'outro'),
          preferred: /watching\.onl/i.test(file) ? 0 : 1,
        };
        if (!best || candidate.preferred < best.preferred) best = candidate;
        if (best && best.preferred === 0) break;
      }
      if (best) return best;
    }
    return null;
  }

  async function extractStreamUrl(episodeHref, lang) {
    const wantDub = String(lang || '').toLowerCase() === 'dub';
    const label = wantDub ? 'dub' : 'sub';
    const empty = { streams: [] };
    return settleWithin(
      (async function () {
        try {
          const parsed = parseHref(episodeHref);
          if (!parsed.slug) return empty;
          const ep = parsed.ep > 0 ? parsed.ep : 1;
          const payload = await fetchSourcesJson(parsed.slug, ep);
          if (!payload) return empty;
          const rows = pickLangSources(payload.sources, wantDub);
          const urls = uniqueSourceUrls(rows);
          if (!urls.length) return empty;

          for (let i = 0; i < urls.length; i += 1) {
            const resolved = await unwrapEmbed(urls[i], wantDub);
            if (!resolved || !resolved.url) continue;
            const headers = resolved.headers || HLS_HEADERS;
            const streamType = resolved.streamType || 'hls';
            const stream = {
              label: (wantDub ? 'Dub' : 'Sub') + ' Auto',
              url: resolved.url,
              streamType: streamType,
              headers: headers,
            };
            const result = {
              streams: [stream],
              headers: headers,
              streamType: streamType,
              lang: label,
              subtitles: resolved.subtitles || [],
            };
            if (resolved.intro) result.intro = resolved.intro;
            if (resolved.outro) result.outro = resolved.outro;
            return result;
          }
          return empty;
        } catch (error) {
          log('stream error: ' + (error && error.message ? error.message : String(error)));
          return empty;
        }
      })(),
      STREAM_DEADLINE_MS,
      empty,
    );
  }

  async function discoveryHome() {
    const sections = [];
    const used = {};
    try {
      const home = await fetchHomeHtml();
      const featured = uniquePublic(parseFeaturedCards(home), 8, used);
      if (featured.length) {
        sections.push({
          id: 'featured',
          title: 'Featured',
          style: 'hero',
          items: featured,
        });
      }

      const latest = await fetchAjaxUpdates('all-updates', 1);
      const latestCards = uniquePublic(latest.items || [], 18, used);
      if (latestCards.length) {
        sections.push({
          id: 'latest',
          title: 'Latest Updates',
          style: 'poster',
          items: latestCards,
          viewAll: { mode: 'feed', feedId: 'latest' },
        });
      }

      const trending = uniquePublic(parseAitemCards(
        ((home.match(/id="trending-anime"[\s\S]*?<\/section>/i) || [''])[0]),
      ), 10, used);
      if (trending.length) {
        sections.push({
          id: 'trending',
          title: 'Top Trending',
          style: 'top10',
          items: trending,
        });
      }

      const fresh = uniquePublic(parseAitemCards(
        ((home.match(/id="alistSwiper"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i) || [''])[0]),
      ), 16, used);
      if (fresh.length) {
        sections.push({
          id: 'new',
          title: 'New Releases',
          style: 'poster',
          items: fresh,
          viewAll: { mode: 'feed', feedId: 'new' },
        });
      }
    } catch (error) {
      log('discovery error: ' + (error && error.message ? error.message : String(error)));
    }
    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    const key = String(feedId || '').trim().toLowerCase();
    const pageNumber = Math.max(1, Number(page) || 1);
    try {
      if (key === 'latest' || key === 'updates') {
        const latest = await fetchAjaxUpdates('all-updates', pageNumber);
        return {
          items: uniquePublic(latest.items || [], 30, {}),
          page: latest.page || pageNumber,
          hasMore: !!latest.hasMore,
        };
      }
      if (key === 'new' || key === 'new-releases') {
        const items = await fetchListingPage('/new-releases', pageNumber);
        return { items: uniquePublic(items, 30, {}), page: pageNumber, hasMore: items.length >= 20 };
      }
      if (key === 'movies' || key === 'movie') {
        const items = await fetchListingPage('/movie', pageNumber);
        return { items: uniquePublic(items, 30, {}), page: pageNumber, hasMore: items.length >= 20 };
      }
      if (key === 'tv') {
        const items = await fetchListingPage('/tv', pageNumber);
        return { items: uniquePublic(items, 30, {}), page: pageNumber, hasMore: items.length >= 20 };
      }
      if (key === 'trending' || key === 'featured') {
        const home = await fetchHomeHtml();
        const items = key === 'featured' ? parseFeaturedCards(home) : parseAitemCards(
          ((home.match(/id="trending-anime"[\s\S]*?<\/section>/i) || [''])[0]),
        );
        return { items: uniquePublic(items, 30, {}), page: 1, hasMore: false };
      }
    } catch (error) {
      log('feed error: ' + (error && error.message ? error.message : String(error)));
    }
    return { items: [], page: pageNumber, hasMore: false };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      searchResults: searchResults,
      extractDetails: extractDetails,
      extractEpisodes: extractEpisodes,
      extractStreamUrl: extractStreamUrl,
      discoveryHome: discoveryHome,
      discoveryFeed: discoveryFeed,
    };
  }
})();
