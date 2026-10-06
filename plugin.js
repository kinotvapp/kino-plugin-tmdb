// TMDB for Kino: a catalog and metadata plugin built only on kino.tmdb (Kino 0.9.53+), which reaches
// api.themoviedb.org/3 with the PERSON'S own TMDB key. This file never sees, stores or sends a key, and
// never talks to TMDB's API itself: Kino does. Images are plain image.tmdb.org URLs Kino loads to show.
//
// This product uses the TMDB API but is not endorsed or certified by TMDB.

const IMG = "https://image.tmdb.org/t/p/";
const SIZE = { poster: "w342", backdrop: "w780", still: "w300", logo: "w500", photo: "w185" };
const MAX_PAGE = 500;            // TMDB never serves a page past 500
const SEASONS_PER_CALL = 10;     // seasons appended to one /tv/{id} call (TMDB allows 20; 10 keeps bodies small)
const MAX_SEASONS = 60;
const MAX_EPISODES = 5000;
const CACHE = "c1:";             // kino.storage keys this plugin owns as a cache
const FRESH_MS = 30 * 60 * 1000;
const STALE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_CACHED_CHARS = 40000;

// ---------- language, region, texts ----------

function setting(key) {
  const v = kino.config.get(key);
  return typeof v === "string" && v && v !== "auto" ? v : null;
}

/** TMDB's `language`: the person's choice, else their device's language (es-ES, other Spanish as es-MX, else en-US). */
function language() {
  const chosen = setting("idioma");
  if (chosen === "es-MX" || chosen === "es-ES" || chosen === "en-US") return chosen;
  const [base, region] = String(kino.lang || "").replace("_", "-").split("-");
  if (String(base).toLowerCase() === "es") return String(region || "").toUpperCase() === "ES" ? "es-ES" : "es-MX";
  return "en-US";
}

/** The country for releases ("CO"): the person's choice, else their device's, else none. */
function region() {
  const chosen = setting("pais");
  if (chosen && /^[A-Z]{2}$/.test(chosen)) return chosen;
  const part = String(kino.lang || "").replace("_", "-").split("-")[1] || "";
  return /^[A-Za-z]{2}$/.test(part) ? part.toUpperCase() : null;
}

const ui = () => (language().startsWith("es") ? "es" : "en");

const TEXT = {
  es: {
    trendDay: "Tendencias de hoy", trendWeek: "Tendencias de la semana",
    popMovie: "Películas populares", popTv: "Series populares",
    topMovie: "Películas mejor valoradas", topTv: "Series mejor valoradas",
    now: "Estrenos en cines", upcoming: "Próximamente en cines", onAir: "Series al aire", airingToday: "Episodios de hoy",
    moviesOf: "Películas de ", seriesOf: "Series de ", seriesTile: "Series: ",
    tabFeatured: "Destacado", tabMovies: "Películas", tabSeries: "Series",
    newerApp: "Este plugin necesita una versión más nueva de la app: actualízala para ver el catálogo de TMDB.",
    noPlay: "TMDB solo muestra el catálogo y la información: busca este título en tus otras fuentes para verlo.",
    ready: (l, r) => `Lista: TMDB responde con tu llave. Catálogo en ${l}${r ? ", país " + r : ""}.`,
    noKey: "Falta tu llave: agrégala en Ajustes ▸ «Tu llave de TMDB», o instala un addon de TMDB de Stremio configurado con tu llave.",
    statusNewer: "Tu versión de la app no trae TMDB para plugins: actualízala.",
    down: "TMDB no respondió ahora; intenta en unos minutos.",
    season: (n) => `Temporada ${n}`,
  },
  en: {
    trendDay: "Trending today", trendWeek: "Trending this week",
    popMovie: "Popular movies", popTv: "Popular series",
    topMovie: "Top rated movies", topTv: "Top rated series",
    now: "Now in theaters", upcoming: "Coming soon to theaters", onAir: "Series on the air", airingToday: "Airing today",
    moviesOf: "Movies: ", seriesOf: "Series: ", seriesTile: "Series: ",
    tabFeatured: "Featured", tabMovies: "Movies", tabSeries: "Series",
    newerApp: "This plugin needs a newer version of the app: update it to see the TMDB catalog.",
    noPlay: "TMDB only shows the catalog and the details: look this title up in your other sources to watch it.",
    ready: (l, r) => `Ready: TMDB answers with your key. Catalog in ${l}${r ? ", country " + r : ""}.`,
    noKey: "Your key is missing: add it in Settings ▸ «Your TMDB key», or install a Stremio TMDB addon set up with your key.",
    statusNewer: "Your version of the app has no TMDB for plugins: update it.",
    down: "TMDB did not answer now; try again in a few minutes.",
    season: (n) => `Season ${n}`,
  },
};
const t = () => TEXT[ui()];

// TMDB's genre ids are fixed; their names in both languages, so a list needs no /genre call.
const GENRES = {
  28: ["Acción", "Action"], 12: ["Aventura", "Adventure"], 16: ["Animación", "Animation"], 35: ["Comedia", "Comedy"],
  80: ["Crimen", "Crime"], 99: ["Documental", "Documentary"], 18: ["Drama", "Drama"], 10751: ["Familia", "Family"],
  14: ["Fantasía", "Fantasy"], 36: ["Historia", "History"], 27: ["Terror", "Horror"], 10402: ["Música", "Music"],
  9648: ["Misterio", "Mystery"], 10749: ["Romance", "Romance"], 878: ["Ciencia ficción", "Science Fiction"],
  10770: ["Película de TV", "TV Movie"], 53: ["Suspenso", "Thriller"], 10752: ["Bélica", "War"], 37: ["Western", "Western"],
  10759: ["Acción y aventura", "Action & Adventure"], 10762: ["Infantil", "Kids"], 10763: ["Noticias", "News"],
  10764: ["Reality", "Reality"], 10765: ["Ciencia ficción y fantasía", "Sci-Fi & Fantasy"], 10766: ["Telenovela", "Soap"],
  10767: ["Entrevistas", "Talk"], 10768: ["Guerra y política", "War & Politics"],
};
const genreName = (id) => (GENRES[id] ? GENRES[id][ui() === "es" ? 0 : 1] : null);

const MOVIE_TILES = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 53, 10752, 37];
const TV_TILES = [16, 35, 80, 18, 99, 10762];

// ---------- the call's clock ----------

let deadline = 0;
function begin(budgetMs) {
  deadline = Date.now() + budgetMs;
}
const timeLeft = () => deadline - Date.now();

// ---------- kino.tmdb, with the checks a person can act on ----------

function newerAppError() {
  return kino.error("unavailable", "kino.tmdb is missing: Kino 0.9.53 or newer is needed", { userMessage: t().newerApp });
}

/**
 * One GET through kino.tmdb. A `rate_limited` or `unavailable` answer (TMDB's 429/5xx, or Kino's own per-plugin limit)
 * is asked once more after a short wait when the call has time left; everything else is thrown as Kino typed it
 * (`no_tmdb_key` carries Kino's own sentence for the person).
 */
async function tmdb(path, params) {
  await null;
  if (typeof kino.tmdb !== "function") throw newerAppError();
  try {
    return await kino.tmdb(path, params);
  } catch (e) {
    const code = e && e.code;
    if ((code === "rate_limited" || code === "unavailable") && timeLeft() > 6000) {
      kino.log("tmdb: retry after", code);
      await kino.sleep(code === "rate_limited" ? 1500 : 700);
      return kino.tmdb(path, params);
    }
    throw e;
  }
}

// ---------- kino.storage cache: a fresh copy, then a stale one when TMDB fails ----------

function cacheRead(key) {
  try {
    const raw = kino.storage.get(CACHE + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheWrite(key, value) {
  let text;
  try {
    text = JSON.stringify({ at: Date.now(), v: value });
  } catch {
    return;
  }
  if (text.length > MAX_CACHED_CHARS) return;
  try {
    kino.storage.set(CACHE + key, text, { ttlMs: STALE_TTL_MS });
  } catch {
    // Full (256 KB): forget this plugin's cache and try once more; a cache is never worth failing a call.
    try {
      for (const k of kino.storage.keys()) if (k.startsWith(CACHE)) kino.storage.remove(k);
      kino.storage.set(CACHE + key, text, { ttlMs: STALE_TTL_MS });
    } catch (e) {
      kino.log("cache: write skipped", e && e.message);
    }
  }
}

const NEVER_STALE = new Set(["no_tmdb_key", "invalid_request", "not_found", "not_allowed"]);

async function cached(key, produce) {
  const hit = cacheRead(key);
  if (hit && Date.now() - hit.at >= 0 && Date.now() - hit.at < FRESH_MS) return hit.v;
  try {
    const value = await produce();
    cacheWrite(key, value);
    return value;
  } catch (e) {
    if (hit && !(e && NEVER_STALE.has(e.code))) {
      kino.log("cache: stale copy served after", e && e.code);
      return hit.v;
    }
    throw e;
  }
}

// ---------- TMDB objects to Kino items ----------

const text = (v) => (typeof v === "string" ? v.trim() : "");
const img = (size, path) => (typeof path === "string" && /^\/[A-Za-z0-9._-]+$/.test(path) ? IMG + size + path : undefined);
const yearOf = (date) => (/^\d{4}/.test(text(date)) ? text(date).slice(0, 4) : undefined);
const validId = (n) => Number.isInteger(n) && n > 0 && n <= 2147483647;

/** A list entry as small as the items need, so a cached page stays a few KB. */
function compact(m, type) {
  const kind = type || m.media_type;
  if (!m || (kind !== "movie" && kind !== "tv") || !validId(m.id) || m.adult === true) return null;
  return {
    id: m.id, k: kind,
    n: text(kind === "movie" ? m.title : m.name), o: text(kind === "movie" ? m.original_title : m.original_name),
    d: text(kind === "movie" ? m.release_date : m.first_air_date),
    p: m.poster_path || null, b: m.backdrop_path || null,
    v: typeof m.vote_average === "number" && m.vote_count > 0 ? m.vote_average : null,
    g: Array.isArray(m.genre_ids) ? m.genre_ids.filter(Number.isInteger).slice(0, 5) : [],
    ov: text(m.overview).slice(0, 400),
  };
}

const itemId = (kind, id) => `${kind === "movie" ? "movie" : "tv"}-${id}`;
const itemRef = (kind, id) => `${kind === "movie" ? "m" : "tv"}:${id}`;

function toItem(c) {
  if (!c) return null;
  const title = c.n || c.o;
  if (!title) return null;
  const item = { id: itemId(c.k, c.id), ref: itemRef(c.k, c.id), title: title.slice(0, 200), kind: c.k === "movie" ? "movie" : "series", ids: { tmdb: c.id } };
  const year = yearOf(c.d);
  if (year) item.year = year;
  const poster = img(SIZE.poster, c.p);
  if (poster) item.poster = poster;
  const backdrop = img(SIZE.backdrop, c.b);
  if (backdrop) item.backdrop = backdrop;
  if (c.ov) item.overview = c.ov;
  if (c.o && c.o !== title) item.originalTitle = c.o.slice(0, 200);
  const genres = c.g.map(genreName).filter(Boolean).slice(0, 5);
  if (genres.length) item.genres = genres;
  if (typeof c.v === "number" && c.v > 0) item.rating = Math.min(10, Math.round(c.v * 10) / 10);
  return item;
}

/** Items in order, without repeats (by Kino id) and without anything that is not a movie or a series. */
function items(compacts) {
  const seen = new Set();
  const out = [];
  for (const c of compacts) {
    const item = toItem(c);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// ---------- the lists (Home rows, "Ver más", section rows, Categorías) ----------

function today(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** Every list by its key: where it comes from and its title. `g:movie:28` / `g:tv:16` are genre lists. */
function listSpec(key) {
  const lang = language();
  const reg = region();
  const T = t();
  const withRegion = (p) => (reg ? { ...p, region: reg } : p);
  const fixed = {
    "trend-day": { path: "/trending/all/day", title: T.trendDay },
    "trend-week": { path: "/trending/all/week", title: T.trendWeek },
    "pop-movie": { path: "/movie/popular", type: "movie", title: T.popMovie, genre: "peliculas", params: withRegion({}) },
    "pop-tv": { path: "/tv/popular", type: "tv", title: T.popTv, genre: "series" },
    "top-movie": { path: "/movie/top_rated", type: "movie", title: T.topMovie, genre: "peliculas", params: withRegion({}) },
    "top-tv": { path: "/tv/top_rated", type: "tv", title: T.topTv, genre: "series" },
    "now": { path: "/movie/now_playing", type: "movie", title: T.now, genre: "peliculas", params: withRegion({}) },
    "upcoming": {
      path: "/discover/movie", type: "movie", title: T.upcoming, genre: "peliculas",
      params: withRegion({ "primary_release_date.gte": today(1), with_release_type: "2|3", sort_by: "popularity.desc", include_adult: false, include_video: false }),
    },
    "on-air": { path: "/tv/on_the_air", type: "tv", title: T.onAir, genre: "series" },
    "airing-today": { path: "/tv/airing_today", type: "tv", title: T.airingToday, genre: "series" },
  };
  if (Object.prototype.hasOwnProperty.call(fixed, key)) return { ...fixed[key], params: { ...(fixed[key].params || {}), language: lang } };
  const g = /^g:(movie|tv):(\d{1,6})$/.exec(key);
  if (g && Object.prototype.hasOwnProperty.call(GENRES, g[2])) {
    const type = g[1];
    const id = Number(g[2]);
    return {
      path: `/discover/${type}`, type,
      title: (type === "movie" ? T.moviesOf : T.seriesOf) + genreName(id),
      genre: genreKind(type, id),
      params: { with_genres: String(id), sort_by: "popularity.desc", include_adult: false, "vote_count.gte": type === "movie" ? 100 : 30, language: lang, ...(type === "movie" ? { include_video: false } : {}) },
    };
  }
  return null;
}

function genreKind(type, id) {
  if (id === 16) return "anime";
  if (id === 99) return "documentales";
  if (id === 10762 || id === 10751) return "infantil";
  return type === "movie" ? "peliculas" : "series";
}

/** One page of a list: `{ items, next }`. Page 1 of each list is cached in kino.storage. */
async function listPage(key, page) {
  const spec = listSpec(key);
  if (!spec) throw kino.error("not_found", "unknown list " + String(key).slice(0, 40));
  const fetchPage = async () => {
    const data = await tmdb(spec.path, { ...spec.params, page });
    const results = Array.isArray(data && data.results) ? data.results : [];
    const total = Math.min(MAX_PAGE, Number(data && data.total_pages) || 1);
    return { c: results.map((m) => compact(m, spec.type)).filter(Boolean), more: page < total };
  };
  const raw = page === 1 ? await cached(`l:${key}:${spec.params.language}:${spec.params.region || ""}`, fetchPage) : await fetchPage();
  const out = { items: items(raw.c) };
  if (raw.more && out.items.length) out.next = String(page + 1);
  if (page === 1) rememberArt(key, out.items);
  return out;
}

/** A backdrop for each genre tile in Categorías, learned from its list (a few bytes each). */
function rememberArt(key, list) {
  if (!key.startsWith("g:")) return;
  const art = list.find((i) => i.backdrop);
  if (!art) return;
  try {
    const all = JSON.parse(kino.storage.get("art") || "{}");
    if (all[key] === art.backdrop) return;
    all[key] = art.backdrop;
    kino.storage.set("art", JSON.stringify(all));
  } catch {
    /* art is decoration only */
  }
}

function row(key, page) {
  const spec = listSpec(key);
  const r = { id: key.replace(/:/g, "-"), title: spec.title, ref: "l:" + key, items: page.items };
  if (spec.genre) r.genre = spec.genre;
  return r;
}

const HOME = [
  "trend-day", "trend-week", "pop-movie", "pop-tv", "now", "upcoming", "top-movie", "top-tv", "on-air",
  "g:movie:28", "g:movie:35", "g:movie:27", "g:movie:16", "g:movie:878", "g:movie:99",
  "g:tv:16", "g:tv:80", "g:tv:18",
];

/**
 * Rows for the keys, in order. The first list is asked alone so a person without a key costs one call; a list that
 * fails is left out; when none answers, the first failure is thrown (Kino shows its reason under the row).
 */
async function rows(keys) {
  const out = [];
  let firstError = null;
  const add = (key, result) => {
    if (result.status === "fulfilled") {
      if (result.value.items.length) out.push(row(key, result.value));
    } else {
      firstError = firstError || result.reason;
      kino.log("list failed", key, result.reason && result.reason.code);
    }
  };
  const [head, ...rest] = keys;
  const first = await Promise.allSettled([listPage(head, 1)]);
  const e = first[0].reason;
  if (e && (e.code === "no_tmdb_key" || e.code === "unavailable" && typeof kino.tmdb !== "function")) throw e;
  add(head, first[0]);
  const settled = await Promise.allSettled(rest.map((k) => listPage(k, 1)));
  rest.forEach((k, i) => add(k, settled[i]));
  if (!out.length && firstError) throw firstError;
  return out;
}

// ---------- exports ----------

export async function home() {
  begin(20000);
  return rows(HOME);
}

function pageOf(cursor) {
  if (cursor === null || cursor === undefined || cursor === "") return 1;
  const n = /^\d{1,3}$/.test(String(cursor)) ? Number(cursor) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : null;
}

export async function browse(ref, cursor) {
  begin(20000);
  await null;
  const page = pageOf(cursor);
  const m = /^l:(.+)$/.exec(String(ref || ""));
  if (!m || !listSpec(m[1])) throw kino.error("not_found", "unknown browse ref");
  if (page === null) return { items: [] };
  return listPage(m[1], page);
}

export async function categories() {
  await null;
  let art = {};
  try {
    art = JSON.parse(kino.storage.get("art") || "{}");
  } catch {
    art = {};
  }
  const tile = (type, id) => {
    const key = `g:${type}:${id}`;
    const tileTitle = (type === "tv" ? t().seriesTile : "") + genreName(id);
    const out = { id: `${type}-${id}`, title: tileTitle.slice(0, 40), ref: "l:" + key };
    if (typeof art[key] === "string" && art[key].startsWith(IMG)) out.art = art[key];
    return out;
  };
  return [...MOVIE_TILES.map((id) => tile("movie", id)), ...TV_TILES.map((id) => tile("tv", id))].slice(0, 24);
}

const TABS = {
  inicio: ["trend-day", "trend-week", "now", "upcoming", "airing-today"],
  peliculas: ["pop-movie", "top-movie", "now", "upcoming", "g:movie:28", "g:movie:35", "g:movie:18", "g:movie:27", "g:movie:878", "g:movie:10749"],
  series: ["pop-tv", "top-tv", "on-air", "airing-today", "g:tv:10759", "g:tv:80", "g:tv:18", "g:tv:35", "g:tv:16", "g:tv:10765"],
};

export async function section(arg) {
  begin(20000);
  const T = t();
  const tabs = [{ id: "inicio", label: T.tabFeatured }, { id: "peliculas", label: T.tabMovies }, { id: "series", label: T.tabSeries }];
  const asked = arg && arg.tab;
  const tab = typeof asked === "string" && Object.prototype.hasOwnProperty.call(TABS, asked) ? asked : "inicio";
  const list = await rows(TABS[tab]);
  const answer = { tabs, tab, rows: list };
  const star = list.length ? list[0].items.find((i) => i.backdrop) : null;
  if (star) {
    answer.hero = { title: star.title, image: star.backdrop };
    if (star.overview) answer.hero.text = star.overview.slice(0, 300);
  }
  return answer;
}

export async function search(query) {
  begin(15000);
  await null;
  const q = text(query && query.q).slice(0, 200);
  if (!q) return [];
  const page = pageOf(query.cursor);
  if (page === null) return { items: [] };
  const lang = language();
  const data = await tmdb("/search/multi", { query: q, include_adult: false, language: lang, page });
  const results = Array.isArray(data && data.results) ? data.results : [];
  const titles = [];
  const people = [];
  for (const r of results) {
    if (r && r.media_type === "person") {
      if (validId(r.id) && r.adult !== true) people.push(r);
    } else {
      titles.push(compact(r));
    }
  }
  // A name search ("Keanu Reeves"): the most popular person's own titles follow the direct hits.
  let theirs = [];
  if (page === 1 && people.length && results.slice(0, 3).some((r) => r && r.media_type === "person") && timeLeft() > 5000) {
    const person = people[0];
    try {
      const credits = await tmdb(`/person/${person.id}/combined_credits`, { language: lang });
      const all = [...(credits.cast || []), ...(credits.crew || []).filter((c) => c.job === "Director" || c.job === "Creator")];
      all.sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0));
      theirs = all.map((m) => compact(m)).filter(Boolean).slice(0, 40);
    } catch (e) {
      kino.log("search: person credits failed", e && e.code);
      theirs = (person.known_for || []).map((m) => compact(m)).filter(Boolean);
    }
  }
  let list = items([...titles, ...theirs]);
  // Kino looking for one title it already knows: put that exact one first.
  if (page === 1 && validId(query.tmdbId) && (query.type === "movie" || query.type === "series") && timeLeft() > 4000) {
    const type = query.type === "movie" ? "movie" : "tv";
    const id = itemId(type, query.tmdbId);
    if (!list.some((i) => i.id === id)) {
      try {
        const exact = toItem(compact(await tmdb(`/${type}/${query.tmdbId}`, { language: lang }), type));
        if (exact) list = [exact, ...list];
      } catch (e) {
        kino.log("search: exact title failed", e && e.code);
      }
    }
  }
  // `type` is a hint: the kind it names goes first, nothing is left out.
  if (query.type === "movie" || query.type === "series") {
    list = [...list.filter((i) => i.kind === query.type), ...list.filter((i) => i.kind !== query.type)];
  }
  const out = { items: list.slice(0, 100) };
  const total = Math.min(MAX_PAGE, Number(data && data.total_pages) || 1);
  if (page < total) out.next = String(page + 1);
  return out;
}

// ---------- series: details and every season's episodes ----------

function seriesRef(ref) {
  const m = /^tv:(\d{1,10})(?::\d{1,4}:\d{1,5})?$/.exec(String(ref || ""));
  return m && validId(Number(m[1])) ? Number(m[1]) : null;
}

/**
 * The episodes of [numbers] seasons of series [id], `SEASONS_PER_CALL` seasons appended to one /tv/{id} call. A call
 * whose body is too large is split in halves, down to a single season; a season that still fails is left out.
 */
async function seasonEpisodes(id, numbers, lang) {
  const chunks = [];
  for (let i = 0; i < numbers.length; i += SEASONS_PER_CALL) chunks.push(numbers.slice(i, i + SEASONS_PER_CALL));
  const out = [];
  const load = async (chunk) => {
    try {
      const data = await tmdb(`/tv/${id}`, { language: lang, append_to_response: chunk.map((n) => "season/" + n).join(",") });
      for (const n of chunk) {
        const s = data && data["season/" + n];
        if (s && Array.isArray(s.episodes)) out.push(...s.episodes);
      }
    } catch (e) {
      if (e && e.code === "too_large" && chunk.length > 1) {
        const half = Math.ceil(chunk.length / 2);
        await Promise.all([load(chunk.slice(0, half)), load(chunk.slice(half))]);
      } else if (e && (e.code === "no_tmdb_key" || e.code === "unavailable" && typeof kino.tmdb !== "function")) {
        throw e;
      } else {
        kino.log("episodes: seasons failed", chunk.join(","), e && e.code);
      }
    }
  };
  await Promise.all(chunks.map(load));
  return out;
}

function seasonNumbers(details) {
  const seasons = Array.isArray(details && details.seasons) ? details.seasons : [];
  const numbers = seasons
    .map((s) => s && s.season_number)
    .filter((n, i) => Number.isInteger(n) && n >= 1 && n <= 999 && (seasons[i].episode_count || 0) > 0);
  return [...new Set(numbers)].sort((a, b) => a - b).slice(0, MAX_SEASONS);
}

export async function episodes(ref) {
  begin(20000);
  await null;
  const id = seriesRef(ref);
  if (!id) throw kino.error("not_found", "not a TMDB series ref");
  const lang = language();
  const details = await tmdb(`/tv/${id}`, { language: lang, append_to_response: "external_ids" });
  const raw = await seasonEpisodes(id, seasonNumbers(details), lang);
  const seen = new Set();
  const list = [];
  for (const e of raw) {
    if (!e || !Number.isInteger(e.season_number) || !Number.isInteger(e.episode_number)) continue;
    if (e.season_number < 1 || e.episode_number < 1 || e.episode_number > 99999) continue;
    const key = e.season_number + ":" + e.episode_number;
    if (seen.has(key)) continue;
    seen.add(key);
    const ep = { season: e.season_number, number: e.episode_number, ref: `tv:${id}:${e.season_number}:${e.episode_number}` };
    if (text(e.name)) ep.title = text(e.name).slice(0, 200);
    if (text(e.overview)) ep.overview = text(e.overview).slice(0, 2000);
    const still = img(SIZE.still, e.still_path);
    if (still) ep.still = still;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text(e.air_date))) ep.airDate = text(e.air_date);
    if (Number.isInteger(e.runtime) && e.runtime >= 1 && e.runtime <= 1000) ep.runtimeMinutes = e.runtime;
    list.push(ep);
  }
  list.sort((a, b) => a.season - b.season || a.number - b.number);
  return { series: seriesInfo(details), episodes: list.slice(0, MAX_EPISODES) };
}

function seriesInfo(d) {
  const info = {};
  const title = text(d && d.name) || text(d && d.original_name);
  if (title) info.title = title.slice(0, 200);
  const poster = img(SIZE.poster, d && d.poster_path);
  if (poster) info.poster = poster;
  const backdrop = img(SIZE.backdrop, d && d.backdrop_path);
  if (backdrop) info.backdrop = backdrop;
  if (text(d && d.overview)) info.overview = text(d.overview).slice(0, 2000);
  const ids = {};
  if (validId(d && d.id)) ids.tmdb = d.id;
  const imdb = d && d.external_ids && d.external_ids.imdb_id;
  if (typeof imdb === "string" && /^tt\d{5,10}$/.test(imdb)) ids.imdb = imdb;
  if (Object.keys(ids).length) info.ids = ids;
  const genres = (Array.isArray(d && d.genres) ? d.genres : []).map((g) => text(g && g.name)).filter(Boolean).slice(0, 5);
  if (genres.length) info.genres = genres;
  const year = yearOf(d && d.first_air_date);
  if (year) info.year = year;
  return info;
}

export async function resolve() {
  await null;
  throw kino.error("not_found", "TMDB is a catalog: it has no streams", { userMessage: t().noPlay });
}

// ---------- meta: describing titles other plugins list ----------

/** The TMDB id and type of a title Kino asks about, by its tmdb id, else its IMDb or TVDB id. Null when unknown. */
async function findTitle(query, lang) {
  const want = query.type === "series" ? "tv" : "movie";
  const ids = (query && query.ids) || {};
  const tmdbId = Number(ids.tmdb);
  if (validId(tmdbId)) return { type: want, id: tmdbId };
  const lookups = [];
  if (typeof ids.imdb === "string" && /^tt\d{5,10}$/.test(ids.imdb)) lookups.push([ids.imdb, "imdb_id"]);
  if (validId(Number(ids.tvdb))) lookups.push([String(ids.tvdb), "tvdb_id"]);
  for (const [value, source] of lookups) {
    const found = await tmdb(`/find/${value}`, { external_source: source, language: lang });
    const movies = (found && found.movie_results) || [];
    const shows = (found && found.tv_results) || [];
    const mine = want === "movie" ? movies : shows;
    const other = want === "movie" ? shows : movies;
    const hit = mine.find((r) => validId(r && r.id)) || other.find((r) => validId(r && r.id));
    if (hit) return { type: mine.includes(hit) ? want : want === "movie" ? "tv" : "movie", id: hit.id };
  }
  return null;
}

function pickLogo(images, lang2) {
  const logos = (images && Array.isArray(images.logos) ? images.logos : []).filter((l) => l && typeof l.file_path === "string" && l.file_path.endsWith(".png"));
  for (const want of [lang2, "en", null]) {
    const best = logos.filter((l) => (l.iso_639_1 || null) === want).sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0];
    if (best) return img(SIZE.logo, best.file_path);
  }
  return undefined;
}

/** English text for a field the person's language left blank, from the title's translations. */
function englishFallback(d, field) {
  const list = d && d.translations && Array.isArray(d.translations.translations) ? d.translations.translations : [];
  const en = list.find((x) => x && x.iso_639_1 === "en" && x.iso_3166_1 === "US") || list.find((x) => x && x.iso_639_1 === "en");
  return en && en.data ? text(en.data[field]) : "";
}

export async function meta(query) {
  begin(6000);
  await null;
  if (!query || (query.type !== "movie" && query.type !== "series")) return null;
  const lang = language();
  const lang2 = lang.slice(0, 2);
  try {
    const found = await findTitle(query, lang);
    if (!found) return null;
    const { type, id } = found;
    const d = await tmdb(`/${type}/${id}`, {
      language: lang,
      append_to_response: "credits,images,external_ids,translations",
      include_image_language: `${lang2},en,null`,
    });
    const answer = {};
    const title = text(type === "movie" ? d.title : d.name) || englishFallback(d, type === "movie" ? "title" : "name");
    if (title) answer.title = title.slice(0, 200);
    const overview = text(d.overview) || englishFallback(d, "overview");
    if (overview) answer.overview = overview.slice(0, 2000);
    const poster = img(SIZE.poster, d.poster_path);
    if (poster) answer.poster = poster;
    const backdrop = img("w1280", d.backdrop_path);
    if (backdrop) answer.backdrop = backdrop;
    const year = yearOf(type === "movie" ? d.release_date : d.first_air_date);
    if (year) answer.year = year;
    const genres = (Array.isArray(d.genres) ? d.genres : []).map((g) => text(g && g.name)).filter(Boolean).slice(0, 5);
    if (genres.length) answer.genres = genres;
    if (type === "movie" && Number.isInteger(d.runtime) && d.runtime >= 1 && d.runtime <= 1000) answer.runtimeMinutes = d.runtime;
    const logo = pickLogo(d.images, lang2);
    if (logo) answer.logo = logo;
    if (typeof d.vote_average === "number" && d.vote_count > 0 && d.vote_average > 0) {
      answer.ratings = [{ source: "tmdb", value: (Math.round(d.vote_average * 10) / 10).toFixed(1) }];
    }
    const seenCast = new Set();
    const cast = [];
    for (const c of (d.credits && Array.isArray(d.credits.cast) ? d.credits.cast : [])) {
      const name = text(c && c.name);
      if (!name || seenCast.has(name)) continue;
      seenCast.add(name);
      const member = { name: name.slice(0, 60) };
      if (text(c.character)) member.character = text(c.character).slice(0, 60);
      const photo = img(SIZE.photo, c.profile_path);
      if (photo) member.photo = photo;
      cast.push(member);
      if (cast.length === 20) break;
    }
    if (cast.length) answer.cast = cast;
    if (type === "tv" && timeLeft() > 2500) {
      const imdb = d.external_ids && /^tt\d{5,10}$/.test(d.external_ids.imdb_id || "") ? d.external_ids.imdb_id : null;
      const own = typeof query.id === "string" && /^(tt\d{5,10}|tmdb:\d{1,10})$/.test(query.id) ? query.id : null;
      const base = own || imdb || `tmdb:${id}`;
      const raw = await seasonEpisodes(id, seasonNumbers(d), lang);
      const seen = new Set();
      const eps = [];
      for (const e of raw) {
        if (!e || !Number.isInteger(e.season_number) || !Number.isInteger(e.episode_number) || e.episode_number < 1) continue;
        const key = e.season_number + ":" + e.episode_number;
        if (seen.has(key)) continue;
        seen.add(key);
        const ep = { season: e.season_number, number: e.episode_number, id: `${base}:${e.season_number}:${e.episode_number}` };
        if (text(e.name)) ep.title = text(e.name).slice(0, 200);
        if (text(e.overview)) ep.overview = text(e.overview).slice(0, 2000);
        const still = img(SIZE.still, e.still_path);
        if (still) ep.still = still;
        if (/^\d{4}-\d{2}-\d{2}$/.test(text(e.air_date))) ep.airDate = text(e.air_date);
        eps.push(ep);
      }
      eps.sort((a, b) => a.season - b.season || a.number - b.number);
      if (eps.length) answer.episodes = eps.slice(0, MAX_EPISODES);
    }
    return Object.keys(answer).length ? answer : null;
  } catch (e) {
    // A meta failure is never shown; no key, a title TMDB lacks or a slow TMDB are just "no answer".
    kino.log("meta: no answer", e && e.code);
    return null;
  }
}

// ---------- the settings tab ----------

export async function settingsStatus() {
  begin(10000);
  await null;
  const T = t();
  if (typeof kino.tmdb !== "function") return { estado: T.statusNewer };
  try {
    await kino.tmdb("/configuration");
    return { estado: T.ready(language(), region()) };
  } catch (e) {
    if (e && e.code === "no_tmdb_key") return { estado: T.noKey };
    return { estado: T.down };
  }
}
