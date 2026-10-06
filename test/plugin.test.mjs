// Offline tests: every TMDB answer comes from test/fixtures/tmdb.json (written by test/make-fixtures.mjs), served
// through a stand-in for kino.tmdb that checks each request exactly as Kino does (sdk/kino-shim.mjs kinoTmdbRequest).
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validate } from "../sdk/validate.mjs";
import { checkOutput, validateManifest } from "../sdk/contract.mjs";
import { createKino, kinoError, kinoTmdbRequest, noTmdbKeyError } from "../sdk/kino-shim.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureFile = join(root, "test", "fixtures", "tmdb.json");
const fixtures = JSON.parse(readFileSync(fixtureFile, "utf8"));
const manifest = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8")).manifest;

const copy = join(mkdtempSync(join(tmpdir(), "kino-tmdb-test-")), "plugin.mjs");
writeFileSync(copy, readFileSync(join(root, "plugin.js")));
const plugin = await import(pathToFileURL(copy).href);

/** The fixture answer for a request, as the kit's KINO_TMDB_FIXTURE does: exact "<path>?<query>", else "<path>". */
function answer(path, params) {
  const { path: p, query } = kinoTmdbRequest(path, params);
  const exact = query ? `${p}?${query}` : p;
  if (Object.hasOwn(fixtures, exact)) return structuredClone(fixtures[exact]);
  if (Object.hasOwn(fixtures, p)) return structuredClone(fixtures[p]);
  throw kinoError("not_found", "no fixture for " + exact);
}

/**
 * A fresh `kino` for one test. [tmdb]: the stand-in for kino.tmdb, `(path, params, n) => answer`, n counting calls;
 * `false` removes kino.tmdb (Kino 0.9.52 and older). Every request is checked like Kino checks it and logged in `calls`.
 */
function setup({ tmdb = answer, lang = "es-CO", config = {} } = {}) {
  const k = createKino(manifest, { lang, config, tmdbFixture: fixtures, metaFixture: {} });
  const calls = [];
  const kino = { ...k.kino };
  if (tmdb === false) delete kino.tmdb;
  else {
    kino.tmdb = async (path, params) => {
      await null;
      kinoTmdbRequest(path, params);
      calls.push({ path, params: params || {} });
      return tmdb(path, params, calls.length);
    };
  }
  globalThis.kino = Object.freeze(kino);
  return { calls, storage: kino.storage };
}

async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail("did not fail");
}

/** What Kino keeps of an answer, and that it drops nothing. */
function kept(fn, value) {
  const r = checkOutput(fn, value, manifest);
  assert.deepEqual(r.drops, [], `${fn} drops: ${r.drops.join("; ")}`);
  return value;
}

// ---------- the kit, exactly as `node sdk/validate.mjs . --run <fn>` ----------

test("the manifest passes the kit: id, name, apiVersion 7, the image host, no resolve-only consent", async () => {
  const r = await validate(root);
  assert.deepEqual(r.problems, []);
  assert.equal(manifest.id, "tmdb");
  assert.equal(manifest.name, "TMDB");
  assert.equal(manifest.apiVersion, 7);
  assert.deepEqual(manifest.hosts, ["image.tmdb.org"]);
  assert.ok(manifest.settings[0].hint.includes("This product uses the TMDB API but is not endorsed or certified by TMDB."));
});

for (const args of [["home"], ["browse", "l:pop-movie"], ["browse", "l:pop-movie", "2"], ["browse", "l:g:movie:28"], ["search", "keanu"],
  ["episodes", "tv:1399"], ["meta", "tt0133093"], ["meta", "tt0944947", "series"], ["meta", "tmdb:1399", "series"], ["categories"],
  ["section"], ["section", "peliculas"], ["section", "series"], ["settingsStatus"]]) {
  test(`kit: validate --run ${args.join(" ")} has no problems and drops nothing`, async () => {
    process.env.KINO_TMDB_FIXTURE = fixtureFile;
    try {
      const r = await validate(root, { run: args[0], args: args.slice(1) });
      assert.deepEqual(r.problems, []);
      assert.deepEqual(r.drops, []);
    } finally {
      delete process.env.KINO_TMDB_FIXTURE;
    }
  });
}

// ---------- home ----------

test("home: every row in order, in the person's language, browsable, with a genre, no repeats and nothing 18+", async () => {
  const { calls } = setup();
  const rows = kept("home", await plugin.home());
  assert.deepEqual(rows.map((r) => r.title), [
    "Tendencias de hoy", "Tendencias de la semana", "Películas populares", "Series populares", "Estrenos en cines",
    "Próximamente en cines", "Películas mejor valoradas", "Series mejor valoradas", "Series al aire",
    "Películas de Acción", "Películas de Comedia", "Películas de Terror", "Películas de Animación", "Películas de Ciencia ficción",
    "Películas de Documental", "Series de Animación", "Series de Crimen", "Series de Drama",
  ]);
  for (const r of rows) {
    assert.ok(r.ref.startsWith("l:"));
    assert.equal(new Set(r.items.map((i) => i.id)).size, r.items.length);
  }
  const today = rows[0].items;
  assert.deepEqual(today.map((i) => i.id), ["movie-603", "tv-1399", "movie-27205", "tv-66732"]);
  assert.ok(!today.some((i) => /adultos/i.test(i.title)));
  const matrix = today[0];
  assert.equal(matrix.ref, "m:603");
  assert.equal(matrix.kind, "movie");
  assert.equal(matrix.poster, "https://image.tmdb.org/t/p/w342/p603.jpg");
  assert.equal(matrix.backdrop, "https://image.tmdb.org/t/p/w780/b603.jpg");
  assert.deepEqual(matrix.genres, ["Acción", "Ciencia ficción"]);
  assert.equal(matrix.ids.tmdb, 603);
  assert.equal(today[1].kind, "series");
  assert.equal(today[1].ref, "tv:1399");
  assert.equal(rows.find((r) => r.id === "g-movie-16").genre, "anime");
  for (const c of calls) assert.equal(c.params.language, "es-MX");
  for (const c of calls.filter((c) => c.path.startsWith("/discover") || c.path === "/search/multi")) assert.equal(c.params.include_adult, false);
  const now = calls.find((c) => c.path === "/movie/now_playing");
  assert.equal(now.params.region, "CO");
  const upcoming = calls.find((c) => c.path === "/discover/movie" && c.params["primary_release_date.gte"]);
  assert.equal(upcoming.params.region, "CO");
  assert.ok(calls.length <= 18, "one call per list");
});

test("home: English for an English device, es-ES for Spain, and the person's own choice wins", async () => {
  let { calls } = setup({ lang: "en-US" });
  const rows = await plugin.home();
  assert.equal(rows[0].title, "Trending today");
  assert.equal(rows[0].items[0].genres[0], "Action");
  assert.ok(calls.every((c) => c.params.language === "en-US"));
  assert.equal(calls.find((c) => c.path === "/movie/now_playing").params.region, "US");
  ({ calls } = setup({ lang: "es-ES" }));
  await plugin.home();
  assert.ok(calls.every((c) => c.params.language === "es-ES"));
  ({ calls } = setup({ lang: "es", config: { idioma: "en-US", pais: "MX" } }));
  await plugin.home();
  assert.ok(calls.every((c) => c.params.language === "en-US"));
  assert.equal(calls.find((c) => c.path === "/movie/now_playing").params.region, "MX");
  ({ calls } = setup({ lang: "es" }));
  await plugin.home();
  assert.equal(calls.find((c) => c.path === "/movie/now_playing").params.region, undefined);
  ({ calls } = setup({ lang: "pt-BR" }));
  await plugin.home();
  assert.ok(calls.every((c) => c.params.language === "en-US"));
});

// ---------- no key, no kino.tmdb ----------

test("no key: home and search throw Kino's own no_tmdb_key after a single call; meta answers null", async () => {
  const { calls } = setup({ tmdb: () => { throw noTmdbKeyError("es-CO"); } });
  const e = await rejects(plugin.home());
  assert.equal(e.code, "no_tmdb_key");
  assert.match(e.userMessage, /Agrega tu llave de TMDB en Ajustes, o instala un addon de TMDB de Stremio/);
  assert.equal(calls.length, 1, "a person without a key costs one call, not eighteen");
  assert.equal((await rejects(plugin.search({ q: "matrix", type: "any", cursor: null }))).code, "no_tmdb_key");
  assert.equal((await rejects(plugin.browse("l:pop-tv", null))).code, "no_tmdb_key");
  assert.equal((await rejects(plugin.episodes("tv:1399"))).code, "no_tmdb_key");
  assert.equal((await rejects(plugin.section({ tab: null }))).code, "no_tmdb_key");
  assert.equal(await plugin.meta({ type: "movie", ids: { imdb: "tt0133093" }, lang: "es" }), null);
});

test("no key: the settings tab says where the key goes; categories still list their tiles", async () => {
  setup({ tmdb: () => { throw noTmdbKeyError("es-CO"); } });
  const status = await plugin.settingsStatus();
  assert.match(status.estado, /Ajustes ▸ «Tu llave de TMDB»/);
  assert.ok(status.estado.length <= 200);
  const tiles = kept("categories", await plugin.categories());
  assert.equal(tiles.length, 24);
  assert.equal(tiles[0].title, "Acción");
  assert.equal(tiles.at(-1).title, "Series: Infantil");
});

test("no key stays no key: a stale cached copy is never shown in its place", async () => {
  setup();
  await plugin.home();
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 60 * 1000;
  try {
    // the same storage, a person who removed their key
    const k = globalThis.kino;
    globalThis.kino = Object.freeze({ ...k, tmdb: async () => { await null; throw noTmdbKeyError("es"); } });
    assert.equal((await rejects(plugin.home())).code, "no_tmdb_key");
  } finally {
    Date.now = realNow;
  }
});

test("a Kino without kino.tmdb (0.9.51, 0.9.52): a typed error saying a newer version is needed", async () => {
  setup({ tmdb: false });
  for (const call of [plugin.home(), plugin.search({ q: "x", type: "any", cursor: null }), plugin.episodes("tv:1399"), plugin.browse("l:now", null)]) {
    const e = await rejects(call);
    assert.equal(e.code, "unavailable");
    assert.match(e.userMessage, /necesita una versión más nueva de la app/);
    assert.ok(!/kino/i.test(e.userMessage), "a userMessage never spells Kino");
  }
  assert.match((await plugin.settingsStatus()).estado, /actualízala/);
  assert.equal(await plugin.meta({ type: "movie", ids: { tmdb: 603 } }), null);
});

// ---------- 429 and 5xx ----------

test("429 once: asked again after a short wait, and the row is there", async () => {
  const seen = new Set();
  const { calls } = setup({
    tmdb: (path, params) => {
      if (path === "/movie/popular" && !seen.has(path)) {
        seen.add(path);
        throw kinoError("rate_limited", "TMDB pidió esperar (429)");
      }
      return answer(path, params);
    },
  });
  const rows = await plugin.home();
  assert.ok(rows.some((r) => r.id === "pop-movie"));
  assert.equal(calls.filter((c) => c.path === "/movie/popular").length, 2);
});

test("429 or 5xx on some lists: the others still make Home; on every list: the error, typed", async () => {
  setup({
    tmdb: (path, params) => {
      if (path.startsWith("/tv/")) throw kinoError("unavailable", "TMDB respondió 503");
      return answer(path, params);
    },
  });
  const rows = await plugin.home();
  assert.ok(!rows.some((r) => r.id === "pop-tv" || r.id === "on-air"));
  assert.ok(rows.some((r) => r.id === "pop-movie"));
  for (const code of ["rate_limited", "unavailable"]) {
    const { calls } = setup({ tmdb: () => { throw kinoError(code, "TMDB " + code); } });
    const e = await rejects(plugin.home());
    assert.equal(e.code, code);
    assert.ok(calls.length <= 36, "at most one retry per list");
  }
  setup({ tmdb: () => { throw kinoError("unavailable", "TMDB respondió 500"); } });
  assert.equal((await rejects(plugin.search({ q: "matrix", type: "any", cursor: null }))).code, "unavailable");
  assert.equal((await rejects(plugin.episodes("tv:1399"))).code, "unavailable");
});

test("a TMDB outage after a good Home: the last copy from kino.storage is served", async () => {
  setup();
  const fresh = await plugin.home();
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60 * 60 * 1000; // past the 30-minute freshness
  try {
    const k = globalThis.kino;
    globalThis.kino = Object.freeze({ ...k, tmdb: async () => { await null; throw kinoError("unavailable", "TMDB respondió 502"); } });
    const stale = await plugin.home();
    assert.deepEqual(stale.map((r) => r.id), fresh.map((r) => r.id));
  } finally {
    Date.now = realNow;
  }
});

test("a fresh cached page is not asked again; storage stays within its budget", async () => {
  const { calls, storage } = setup();
  await plugin.home();
  const first = calls.length;
  await plugin.home();
  assert.equal(calls.length, first);
  const size = JSON.stringify(Object.fromEntries(storage.keys().map((k) => [k, storage.get(k)]))).length;
  assert.ok(size < 128 * 1024, `storage ${size} characters`);
});

// ---------- paging ----------

test("browse: pages follow TMDB's, the last page has no next, a bad cursor or ref is handled", async () => {
  const { calls } = setup();
  const p1 = kept("browse", await plugin.browse("l:pop-movie", null));
  assert.equal(p1.next, "2");
  assert.equal(p1.items.length, 4);
  const p2 = kept("browse", await plugin.browse("l:pop-movie", "2"));
  assert.equal(p2.next, "3");
  assert.equal(p2.items[0].id, "movie-680");
  const p3 = await plugin.browse("l:pop-movie", "3");
  assert.equal(p3.next, undefined);
  assert.deepEqual(calls.map((c) => c.params.page), [1, 2, 3]);
  assert.deepEqual(await plugin.browse("l:pop-movie", "999999"), { items: [] });
  assert.deepEqual(await plugin.browse("l:pop-movie", "abc"), { items: [] });
  assert.equal((await rejects(plugin.browse("l:nope", null))).code, "not_found");
  assert.equal((await rejects(plugin.browse("l:constructor", null))).code, "not_found");
  const tv = await plugin.browse("l:pop-tv", "499");
  assert.equal(tv.next, "500");
  setup({ tmdb: () => ({ page: 500, results: fixtures["/tv/popular"].results, total_pages: 9000 }) });
  assert.equal((await plugin.browse("l:pop-tv", "500")).next, undefined, "TMDB never serves past page 500");
});

test("browse of a genre tile asks discover with that genre, and teaches Categorías its art", async () => {
  const { calls } = setup();
  const before = await plugin.categories();
  assert.equal(before.find((c) => c.id === "movie-27").art, undefined);
  const page = await plugin.browse("l:g:movie:27", null);
  assert.ok(page.items.length > 0);
  assert.equal(calls[0].path, "/discover/movie");
  assert.equal(calls[0].params.with_genres, "27");
  assert.equal(calls[0].params.include_adult, false);
  const after = await plugin.categories();
  assert.match(after.find((c) => c.id === "movie-27").art, /^https:\/\/image\.tmdb\.org\/t\/p\/w780\//);
});

// ---------- search ----------

test("search: movies and series, a person's own titles after them, repeats and 18+ dropped, paged", async () => {
  const { calls } = setup();
  const r = kept("search", await plugin.search({ q: "keanu", type: "any", cursor: null, tmdbId: 0, year: 0, season: 0, episode: 0 }));
  const ids = r.items.map((i) => i.id);
  assert.deepEqual(ids, ["movie-603", "tv-1399", "movie-27205", "tv-66732", "movie-1880", "movie-77777"]);
  assert.equal(r.next, "2");
  assert.ok(calls.some((c) => c.path === "/person/6384/combined_credits"));
  assert.equal(calls[0].params.include_adult, false);
  assert.deepEqual(await plugin.search({ q: "  ", type: "any", cursor: null }), []);
  const p2 = await plugin.search({ q: "keanu", type: "any", cursor: "2" });
  assert.equal(p2.next, undefined);
});

test("search: the type hint goes first, and Kino's own tmdbId is put on top", async () => {
  setup();
  const r = await plugin.search({ q: "juego", type: "series", cursor: null, tmdbId: 1396 });
  assert.equal(r.items[0].id, "tv-1396");
  const kinds = r.items.map((i) => i.kind);
  assert.deepEqual(kinds, [...kinds].sort((a, b) => (a === "series" ? 0 : 1) - (b === "series" ? 0 : 1)));
});

// ---------- episodes ----------

test("episodes: every season but specials, with stills and air dates, and the series' info", async () => {
  const { calls } = setup();
  const r = kept("episodes", await plugin.episodes("tv:1399"));
  assert.deepEqual(r.episodes.map((e) => `${e.season}x${e.number}`), ["1x1", "1x2", "1x3", "2x1", "2x2"]);
  const first = r.episodes[0];
  assert.equal(first.ref, "tv:1399:1:1");
  assert.equal(first.title, "Capítulo 1x1");
  assert.equal(first.still, "https://image.tmdb.org/t/p/w300/s1399-1-1.jpg");
  assert.equal(first.airDate, "2011-01-10");
  assert.equal(first.runtimeMinutes, 55);
  assert.equal(r.series.ids.imdb, "tt0944947");
  assert.equal(r.series.title, "Juego de tronos");
  const seasons = calls.find((c) => c.params.append_to_response && c.params.append_to_response.startsWith("season/"));
  assert.equal(seasons.params.append_to_response, "season/1,season/2");
  assert.equal((await rejects(plugin.episodes("m:603"))).code, "not_found");
});

test("episodes: a body too large is split season by season", async () => {
  const many = { ...fixtures["/tv/1399"], seasons: Array.from({ length: 12 }, (_, i) => ({ season_number: i + 1, episode_count: 1 })) };
  const { calls } = setup({
    tmdb: (path, params) => {
      const ask = (params.append_to_response || "").split(",").filter((s) => s.startsWith("season/"));
      if (ask.length > 3) throw kinoError("too_large", "TMDB body over 2 MiB");
      const body = { ...many };
      for (const s of ask) body[s] = { episodes: [{ season_number: Number(s.slice(7)), episode_number: 1, name: s }] };
      return body;
    },
  });
  const r = await plugin.episodes("tv:1399");
  assert.equal(r.episodes.length, 12);
  assert.ok(calls.length > 3);
});

// ---------- meta ----------

test("meta by IMDb id (a movie): found through /find, English overview when Spanish is blank, logo, rating, cast", async () => {
  const { calls } = setup();
  const m = kept("meta", await plugin.meta({ type: "movie", ids: { imdb: "tt0133093" }, lang: "es" }));
  assert.equal(calls[0].path, "/find/tt0133093");
  assert.equal(calls[0].params.external_source, "imdb_id");
  assert.equal(m.overview, "A hacker learns the truth.");
  assert.equal(m.year, "1999");
  assert.equal(m.runtimeMinutes, 136);
  assert.equal(m.logo, "https://image.tmdb.org/t/p/w500/matrix-en.png");
  assert.deepEqual(m.ratings, [{ source: "tmdb", value: "8.2" }]);
  assert.deepEqual(m.cast.map((c) => c.name), ["Keanu Reeves", "Carrie-Anne Moss"]);
  assert.equal(m.cast[0].photo, "https://image.tmdb.org/t/p/w185/kr.jpg");
  assert.equal(m.episodes, undefined);
});

test("meta by TMDB id (a series): no /find, the Spanish logo (PNG only), episodes with the Stremio ids", async () => {
  const { calls } = setup();
  const m = kept("meta", await plugin.meta({ type: "series", ids: { tmdb: 1399 }, lang: "es" }));
  assert.ok(!calls.some((c) => c.path.startsWith("/find")));
  assert.equal(m.logo, "https://image.tmdb.org/t/p/w500/logo-es.png");
  assert.deepEqual(m.episodes.map((e) => e.id), ["tt0944947:1:1", "tt0944947:1:2", "tt0944947:1:3", "tt0944947:2:1", "tt0944947:2:2"]);
  assert.equal(m.runtimeMinutes, undefined);
  const own = await plugin.meta({ type: "series", ids: { tmdb: 1399 }, id: "tmdb:1399" });
  assert.equal(own.episodes[0].id, "tmdb:1399:1:1");
  const byImdb = await plugin.meta({ type: "series", ids: { imdb: "tt0944947" } });
  assert.equal(byImdb.title, "Juego de tronos");
});

test("meta: a title TMDB lacks, ids it can't use, or a failure are all null, never a throw", async () => {
  setup();
  assert.equal(await plugin.meta({ type: "movie", ids: { imdb: "tt9999999" } }), null);
  assert.equal(await plugin.meta({ type: "series", ids: { kitsu: 1376 } }), null);
  assert.equal(await plugin.meta({ type: "other", ids: { tmdb: 1 } }), null);
  assert.equal(await plugin.meta(null), null);
  setup({ tmdb: () => { throw kinoError("rate_limited", "429"); } });
  assert.equal(await plugin.meta({ type: "movie", ids: { tmdb: 603 } }), null);
});

// ---------- section, resolve ----------

test("section: three tabs, a hero, rows per tab; an unknown tab reads as the first", async () => {
  setup();
  const s = await plugin.section({ tab: null });
  assert.deepEqual(s.tabs.map((x) => x.id), ["inicio", "peliculas", "series"]);
  assert.equal(s.tab, "inicio");
  assert.equal(s.hero.title, "Matrix");
  assert.equal((await plugin.section({ tab: "series" })).rows[0].id, "pop-tv");
  assert.equal((await plugin.section({ tab: "__proto__" })).tab, "inicio");
});

test("resolve: a catalog has no streams, and says so in the person's words", async () => {
  setup();
  const e = await rejects(plugin.resolve("m:603"));
  assert.equal(e.code, "not_found");
  assert.match(e.userMessage, /solo muestra el catálogo/);
});

test("no request ever carries a key or reaches past the allowed TMDB paths", async () => {
  const { calls } = setup();
  await plugin.home();
  await plugin.search({ q: "keanu", type: "any", cursor: null });
  await plugin.episodes("tv:1399");
  await plugin.meta({ type: "movie", ids: { imdb: "tt0133093" } });
  await plugin.settingsStatus();
  for (const c of calls) {
    assert.ok(!Object.keys(c.params).some((k) => /key|token|session/i.test(k)));
    assert.ok(Object.values(c.params).every((v) => ["string", "number", "boolean"].includes(typeof v)));
  }
  const src = readFileSync(join(root, "plugin.js"), "utf8");
  assert.ok(!/kino\.fetch|api\.themoviedb\.org|api_key/.test(src.replace(/^\s*\/\/.*$/gm, "")), "TMDB is only reached through kino.tmdb");
  for (const name of ["setTimeout", "structuredClone", "Intl", "Buffer", "process", "require("]) assert.ok(!src.includes(name), name + " does not exist in Kino");
});
