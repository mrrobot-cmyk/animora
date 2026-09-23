(() => {
  'use strict';

  const MODULE_NAME = 'Anikage';
  const BASE_URL = 'https://anikage.cc';
  const PROXY_CDN = 'https://og.bakayaro.live';
  const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  function log(message) {
    try {
      if (typeof debugPrint === 'function') debugPrint('[' + MODULE_NAME + '] ' + String(message || ''));
      else if (typeof console !== 'undefined' && console.log) console.log('[' + MODULE_NAME + '] ' + String(message || ''));
    } catch (_) {}
  }

  function decodeHtml(text) {
    return String(text || '')
      .replace(/&#0?39;|&#x27;|&apos;/g, "'")
      .replace(/&#8217;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  // ---------- HTTP bridge ----------

  async function requestJson(url, extraHeaders) {
    const headers = Object.assign({
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': BASE_URL + '/',
      'Origin': BASE_URL,
    }, extraHeaders || {});

    let res = null;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, headers, 'GET', null);
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { headers });
    }

    const status = Number((res && res.status) || 0);
    if (status < 200 || status >= 400) {
      throw new Error(MODULE_NAME + ': request failed (HTTP ' + status + ') for ' + url);
    }

    if (res && typeof res.json === 'function') {
      try {
        const j = await res.json();
        if (j !== null && j !== undefined) return j;
      } catch (_) {}
    }
    if (res && res.json && typeof res.json === 'object') return res.json;

    let text = '';
    if (res && typeof res.text === 'function') { try { text = await res.text(); } catch (_) {} }
    else if (res && typeof res.body === 'string') text = res.body;

    if (text) {
      try { return JSON.parse(text); } catch (_) {}
    }
    throw new Error(MODULE_NAME + ': response from ' + url + ' was not valid JSON');
  }

  // ---------- helpers ----------

  async function resolveAnimeSlug(rawSlug) {
    let slug = String(rawSlug || '').trim();
    if (!slug) throw new Error(MODULE_NAME + ': empty anime slug');

    if (slug.startsWith('http://') || slug.startsWith('https://')) {
      const m = slug.match(/\/(?:anime\/)?(?:watch|info)\/([^/?#]+)/i) || slug.match(/\/watch\/([^/?#]+)/i);
      slug = m ? m[1] : '';
    } else {
      slug = slug.replace(/^\/?(anime\/)?(watch|info)\//i, '').replace(/^\/+|\/+$/g, '').split('/')[0];
    }
    if (!slug) throw new Error(MODULE_NAME + ': empty anime slug');

    // If slug is a 10-character Anikage ID or valid slug, check if valid
    try {
      const test = await requestJson(BASE_URL + '/api/media/anime/' + slug);
      if (test && (test.anime || test.slug || test.anilistId)) return slug;
    } catch (_) {}

    // Fallback: search by title / keywords
    const searchRes = await searchResults(slug.replace(/[-_]+/g, ' '));
    if (searchRes.length > 0) {
      return searchRes[0].id;
    }

    return slug;
  }

  function formatTitle(titleObj, fallback) {
    if (!titleObj || typeof titleObj !== 'object') return fallback || 'Anime';
    return titleObj.english || titleObj.userPreferred || titleObj.romaji || titleObj.native || fallback || 'Anime';
  }

  function formatImage(coverObj) {
    if (!coverObj) return '';
    if (typeof coverObj === 'string') return coverObj;
    return coverObj.extraLarge || coverObj.large || coverObj.medium || '';
  }

  // ---------- search ----------

  async function searchResults(query) {
    const q = String(query || '').trim();
    const url = BASE_URL + '/api/media/anime/browse?' + (q ? 'q=' + encodeURIComponent(q) : 'sort=TRENDING_DESC');
    const data = await requestJson(url);
    const results = (data && data.data) || [];

    return results.map((item) => {
      const title = formatTitle(item.title, item.slug);
      const poster = formatImage(item.coverImage);
      return {
        id: item.slug,
        href: BASE_URL + '/anime/info/' + item.slug,
        title: title,
        image: poster,
        poster: poster,
      };
    });
  }

  // ---------- details ----------

  async function extractDetails(urlOrId) {
    const slug = await resolveAnimeSlug(urlOrId);
    const data = await requestJson(BASE_URL + '/api/media/anime/' + slug);
    const anime = (data && data.anime) || data || {};

    const title = formatTitle(anime.title, slug);
    const poster = formatImage(anime.coverImage);
    const banner = anime.bannerImage || anime.fanart || poster;

    return {
      id: slug,
      href: BASE_URL + '/anime/info/' + slug,
      title: title,
      description: anime.description ? decodeHtml(anime.description.replace(/<[^>]*>/g, '')) : 'Watch on Anikage',
      image: poster,
      poster: poster,
      banner: banner,
      genres: Array.isArray(anime.genres) ? anime.genres : [],
      anilistId: anime.anilistId || 0,
      totalEpisodes: anime.episodes_total || anime.totalEpisodes || 0,
    };
  }

  // ---------- episodes ----------

  async function extractEpisodes(seriesId) {
    const slug = await resolveAnimeSlug(seriesId);
    const rawEpisodes = await requestJson(BASE_URL + '/api/media/anime/' + slug + '/episodes');
    const list = Array.isArray(rawEpisodes) ? rawEpisodes : [];

    return list.map((ep, idx) => {
      const epNum = ep.number || ep.episodeInSeason || (idx + 1);
      const epTitle = ep.title ? ('Episode ' + epNum + ': ' + ep.title) : ('Episode ' + epNum);

      return {
        id: slug + ':ep:' + epNum,
        number: epNum,
        title: 'S1E' + epNum + ': ' + epTitle,
        href: 'anikage-stream:' + JSON.stringify({ slug: slug, ep: epNum }),
        hasSub: true,
        hasDub: ep.hasDub === true || true,
        subAvailable: true,
        dubAvailable: ep.hasDub === true || true,
        image: ep.img || ep.image || '',
      };
    });
  }

  // ---------- stream resolution ----------

  async function extractStreamUrl(episodeHref, lang) {
    const raw = String(episodeHref || '').trim();
    let slug = '';
    let epNum = 1;

    if (raw.startsWith('anikage-stream:')) {
      const parsed = JSON.parse(raw.slice('anikage-stream:'.length));
      slug = parsed.slug;
      epNum = parsed.ep;
    } else if (raw.includes(':ep:')) {
      const parts = raw.split(':ep:');
      slug = parts[0];
      epNum = parseInt(parts[1], 10) || 1;
    } else {
      const m = raw.match(/\/watch\/([^\/]+)\/([0-9]+)/i) || raw.match(/([^\/]+)\/episode\/([0-9]+)/i);
      if (m) {
        slug = m[1];
        epNum = parseInt(m[2], 10) || 1;
      } else {
        slug = await resolveAnimeSlug(raw);
      }
    }

    const targetLang = String(lang || 'sub').toLowerCase() === 'dub' ? 'dub' : 'sub';

    // Provider candidate pool in priority order
    const providers = ['koto', 'kiwi', 'neko', 'wave', 'megg'];
    let lastError = null;

    for (const provider of providers) {
      try {
        const queryUrl = BASE_URL + '/api/media/anime/' + encodeURIComponent(slug) + '/episodes/' + epNum + '/sources?provider=' + provider + '&lang=' + targetLang;
        const data = await requestJson(queryUrl, {
          'Referer': BASE_URL + '/anime/watch/' + slug,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        });

        const sources = (data && data.sources) || [];
        if (!sources.length) continue;

        const primary = sources[0];
        let streamUrl = primary.url || '';
        if (!streamUrl) continue;

        if (!streamUrl.startsWith('http')) {
          streamUrl = PROXY_CDN + '/' + streamUrl;
        }

        const headers = {
          'User-Agent': USER_AGENT,
          'Referer': BASE_URL + '/',
          'Origin': BASE_URL,
        };

        const subtitles = ((data && data.subtitles) || []).map((sub) => {
          let subUrl = sub.file || sub.url || '';
          if (subUrl && !subUrl.startsWith('http')) {
            subUrl = PROXY_CDN + '/' + subUrl;
          }
          return {
            url: subUrl,
            language: sub.label || 'English',
            label: sub.label || 'English',
            format: 'vtt',
            default: sub.default === true,
          };
        }).filter((s) => Boolean(s.url));

        const intro = (data && data.intro) || {};
        const outro = (data && data.outro) || {};

        return {
          url: streamUrl,
          headers: headers,
          streamType: primary.isM3U8 === false ? 'mp4' : 'hls',
          quality: primary.quality || 'Auto',
          subtitles: subtitles,
          introStartSeconds: typeof intro.start === 'number' && intro.start > 0 ? intro.start : null,
          introEndSeconds: typeof intro.end === 'number' && intro.end > 0 ? intro.end : null,
          outroStartSeconds: typeof outro.start === 'number' && outro.start > 0 ? outro.start : null,
          outroEndSeconds: typeof outro.end === 'number' && outro.end > 0 ? outro.end : null,
        };
      } catch (err) {
        lastError = err;
        log('Provider ' + provider + ' failed (' + (err && err.message) + '), trying next provider...');
      }
    }

    throw new Error(MODULE_NAME + ': unable to resolve playable stream for ' + slug + ' ep ' + epNum + '. Last error: ' + (lastError ? lastError.message : 'unknown'));
  }

  // ---------- discovery ----------

  async function discoveryHome() {
    const [trending, popular, topRated] = await Promise.all([
      requestJson(BASE_URL + '/api/media/anime/browse?sort=TRENDING_DESC&page=1'),
      requestJson(BASE_URL + '/api/media/anime/browse?sort=POPULARITY_DESC&page=1'),
      requestJson(BASE_URL + '/api/media/anime/browse?sort=SCORE_DESC&page=1'),
    ]);

    const trendingItems = (trending && trending.data) || [];
    const popularItems = (popular && popular.data) || [];
    const topRatedItems = (topRated && topRated.data) || [];

    const mapItem = (item) => ({
      id: item.slug,
      href: BASE_URL + '/anime/info/' + item.slug,
      title: formatTitle(item.title, item.slug),
      image: formatImage(item.coverImage),
    });

    const sections = [];

    // 1. Hero Featured Carousel
    sections.push({
      id: 'featured_trending',
      title: 'Featured Anime',
      style: 'hero',
      viewAll: { mode: 'feed', feedId: 'trending' },
      items: trendingItems.slice(0, 8).map(mapItem),
    });

    // 2. Top 10 Popular
    sections.push({
      id: 'top10_popular',
      title: 'Top 10 Most Popular',
      style: 'top10',
      viewAll: { mode: 'feed', feedId: 'popular' },
      items: popularItems.slice(0, 10).map(mapItem),
    });

    // 3. Trending Now
    sections.push({
      id: 'trending_now',
      title: 'Trending on Anikage',
      style: 'poster',
      viewAll: { mode: 'feed', feedId: 'trending' },
      items: trendingItems.slice(0, 24).map(mapItem),
    });

    // 4. Top Rated
    sections.push({
      id: 'top_rated',
      title: 'Top Rated Anime',
      style: 'poster',
      viewAll: { mode: 'feed', feedId: 'top_rated' },
      items: topRatedItems.slice(0, 24).map(mapItem),
    });

    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    const pageNum = Math.max(1, Number(page) || 1);
    let sort = 'TRENDING_DESC';

    if (feedId === 'popular') sort = 'POPULARITY_DESC';
    else if (feedId === 'top_rated') sort = 'SCORE_DESC';
    else if (feedId === 'favourites') sort = 'FAVOURITES_DESC';

    const data = await requestJson(BASE_URL + '/api/media/anime/browse?sort=' + sort + '&page=' + pageNum);
    const results = (data && data.data) || [];

    return {
      items: results.map((item) => ({
        id: item.slug,
        href: BASE_URL + '/anime/info/' + item.slug,
        title: formatTitle(item.title, item.slug),
        image: formatImage(item.coverImage),
      })),
      page: pageNum,
      hasMore: results.length >= 20,
    };
  }

  // ---------- Exports on globalThis ----------

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
  globalThis.extractHome = discoveryHome;
  globalThis.extractFeed = discoveryFeed;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      searchResults,
      extractDetails,
      extractEpisodes,
      extractStreamUrl,
      discoveryHome,
      discoveryFeed,
      extractHome: discoveryHome,
      extractFeed: discoveryFeed,
    };
  }
})();
