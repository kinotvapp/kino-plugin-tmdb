// Offline tests of the "movies" door (plugin protocol, Kino 0.9.81): the proto_movies_* exports other plugins reach through
// kino.plugins.call. No network, no key: kino.tmdb is a stand-in, or the kit's own with test/fixtures/movies-door.json.
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validate } from "../sdk/validate.mjs";
import { validateManifest } from "../sdk/contract.mjs";
import { createKino } from "../sdk/kino-shim.mjs";
import { createProtocolCaller, protocolBlocks } from "../sdk/protocol.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawManifest = JSON.parse(readFileSync(join(root, "kino-plugin.json"), "utf8"));
const manifest = validateManifest(JSON.stringify(rawManifest)).manifest;

const copy = join(mkdtempSync(join(tmpdir(), "kino-tmdb-door-")), "plugin.mjs");
writeFileSync(copy, readFileSync(join(root, "plugin.js")));
const plugin = await import(pathToFileURL(copy).href);

/** A kino whose tmdb answers by path prefix from [answers]; records every call. A value may be a function or an Error. */
function fakeKino(answers) {
  const calls = [];
  globalThis.kino = {
    lang: "es-CO",
    config: { get: () => null },
    log: () => {},
    tmdb: async (path, params) => {
      calls.push({ path, params });
      const key = Object.keys(answers).find((k) => path === k || path.startsWith(k + "/"));
      if (key === undefined) throw Object.assign(new Error("nope"), { code: "not_found" });
      const a = typeof answers[key] === "function" ? answers[key](path, params) : answers[key];
      if (a instanceof Error) throw a;
      return JSON.parse(JSON.stringify(a));
    },
  };
  return calls;
}
const withCode = (code) => Object.assign(new Error("tmdb said " + code), { code });

const matrix = {
  id: 603, title: "Matrix", release_date: "1999-03-30", overview: "Un experto en computación descubre que su mundo es una simulación.",
  poster_path: "/hEpWvX6Bp79eLxY1kX5ZZJcme5U.jpg", adult: false, vote_average: 8.2, popularity: 80,
  credits: { cast: [{ name: "Keanu Reeves" }], crew: [{ name: "Joel Silver", job: "Producer" }, { name: "Lana Wachowski", job: "Director" }] },
};

test("manifest: the door sits in enhancements[\"20\"], the plugin stays apiVersion 7 with every capability it had", async () => {
  assert.equal(rawManifest.apiVersion, 7);
  assert.equal(rawManifest.version, "1.3.0");
  assert.equal("provides" in rawManifest, false, "never top level: below apiVersion 20 Kino would refuse it");
  assert.deepEqual(rawManifest.capabilities, ["search", "home", "browse", "episodes", "resolve", "meta"]);
  assert.equal(rawManifest.catalogOnly, true);
  // A Kino before 0.9.81 never reads enhancements["20"]: the manifest without it is valid and asks for the same things.
  const older = structuredClone(rawManifest);
  delete older.enhancements;
  const o = validateManifest(JSON.stringify(older));
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.manifest.capabilities, manifest.capabilities);
  // Kino 0.9.81 reads it as the door "movies".
  const blocks = protocolBlocks(rawManifest);
  assert.deepEqual(blocks.problems, []);
  assert.equal(blocks.provides.length, 1);
  const r = await validate(root);
  assert.deepEqual(r.problems, []);
  assert.ok(!r.notes.some((n) => /does not export proto_/.test(n)), r.notes.join("\n"));
  for (const name of ["proto_movies_byId", "proto_movies_random", "proto_movies_search", "proto_movies_trending"]) assert.equal(typeof plugin[name], "function", name);
});

test("byIdMapsToMovieWithDirectorInOneRequest", async () => {
  const calls = fakeKino({ "/movie": matrix });
  const movie = await plugin.proto_movies_byId({ id: 603 });
  assert.deepEqual(movie, {
    id: 603, title: "Matrix", year: 1999, director: "Lana Wachowski",
    overview: "Un experto en computación descubre que su mundo es una simulación.",
    posterUrl: "https://image.tmdb.org/t/p/w342/hEpWvX6Bp79eLxY1kX5ZZJcme5U.jpg",
  });
  assert.equal(calls.length, 1, "exactly one kino.tmdb request");
  assert.equal(calls[0].path, "/movie/603");
  assert.equal(calls[0].params.append_to_response, "credits");
  assert.equal(calls[0].params.language, "es-MX", "the person's catalog language, as the rest of the plugin");
});

test("byId leaves out the optional fields TMDB does not have, and a bad id asks nothing", async () => {
  const calls = fakeKino({ "/movie": { id: 5, title: "Sparse", release_date: "2001-01-01", overview: "", poster_path: null, credits: { crew: [] } } });
  assert.deepEqual(await plugin.proto_movies_byId({ id: 5 }), { id: 5, title: "Sparse", year: 2001 });
  await assert.rejects(plugin.proto_movies_byId({ id: -1 }), { message: "not_found" });
  await assert.rejects(plugin.proto_movies_byId({ id: 1.5 }), { message: "not_found" });
  assert.equal(calls.length, 1);
});

test("randomPicksOneResultWithinYearRange", async () => {
  const calls = fakeKino({
    "/discover/movie": { page: 3, results: [{ id: 680, title: "Pulp Fiction", release_date: "1994-09-10" }, { id: 13, title: "Forrest Gump", release_date: "1994-06-23" }] },
    "/movie": (path) => ({ id: Number(path.split("/")[2]), title: "Forrest Gump", release_date: "1994-06-23", credits: { crew: [{ name: "Robert Zemeckis", job: "Director" }] } }),
  });
  const seq = [0.25, 0.9]; // page 3, then the second row
  const realRandom = Math.random;
  Math.random = () => seq.shift();
  try {
    const movie = await plugin.proto_movies_random({ fromYear: 1994, toYear: 1994 });
    assert.equal(movie.id, 13);
    assert.equal(movie.director, "Robert Zemeckis");
  } finally {
    Math.random = realRandom;
  }
  assert.equal(calls.length, 2, "a discover page, then one byId-style request");
  assert.equal(calls[0].path, "/discover/movie");
  assert.equal(calls[0].params.page, 3);
  assert.equal(calls[0].params.include_adult, false);
  assert.equal(calls[0].params["primary_release_date.gte"], "1994-01-01");
  assert.equal(calls[0].params["primary_release_date.lte"], "1994-12-31");
  assert.equal(calls[1].path, "/movie/13");
  assert.equal(calls[1].params.append_to_response, "credits");
});

test("random without a range asks for no dates", async () => {
  const calls = fakeKino({ "/discover/movie": { results: [{ id: 603, title: "Matrix", release_date: "1999-03-30" }] }, "/movie": matrix });
  await plugin.proto_movies_random({});
  assert.equal("primary_release_date.gte" in calls[0].params, false);
  assert.equal("primary_release_date.lte" in calls[0].params, false);
});

test("random falls back to page 1 when the picked page is empty", async () => {
  const calls = fakeKino({
    "/discover/movie": (_, params) => ({ results: params.page === 1 ? [{ id: 603, title: "Matrix", release_date: "1999-03-30" }] : [] }),
    "/movie": matrix,
  });
  const realRandom = Math.random;
  Math.random = () => 0.5;
  try {
    assert.equal((await plugin.proto_movies_random({ fromYear: 1999 })).id, 603);
  } finally {
    Math.random = realRandom;
  }
  assert.deepEqual(calls.map((c) => c.params.page), [6, 1, undefined]);
});

test("random skips a discover row without a release date", async () => {
  const calls = fakeKino({
    "/discover/movie": { results: [{ id: 1, title: "Undated", release_date: "" }, { id: 2, title: "Dated", release_date: "2003-01-01" }] },
    "/movie": (path) => ({ id: Number(path.split("/")[2]), title: "Dated", release_date: "2003-01-01" }),
  });
  const realRandom = Math.random;
  Math.random = () => 0; // first row of the pool, which must be the dated one
  try {
    assert.equal((await plugin.proto_movies_random({})).id, 2);
  } finally {
    Math.random = realRandom;
  }
  assert.equal(calls[1].path, "/movie/2");
});

test("neverReturnsAdultTitles", async () => {
  const adult = { id: 999, title: "Adult One", release_date: "2010-01-01", adult: true };
  const ok = { id: 603, title: "Matrix", release_date: "1999-03-30", adult: false };
  const calls = fakeKino({
    "/search/movie": { results: [adult, ok] },
    "/trending/movie": { results: [adult, ok] },
    "/discover/movie": { results: [adult] },
    "/movie": { ...adult, credits: { crew: [] } },
  });
  assert.deepEqual((await plugin.proto_movies_search({ q: "x" })).map((m) => m.id), [603]);
  assert.equal(calls[0].params.include_adult, false);
  const t = await plugin.proto_movies_trending(null);
  assert.deepEqual(t.items.map((m) => m.id), [603]);
  assert.equal(calls[1].params.include_adult, false);
  // a discover page with only adult rows is empty to us
  await assert.rejects(plugin.proto_movies_random({}), { message: "not_found" });
  assert.equal(calls[2].params.include_adult, false);
  // an adult record asked by id is never returned
  await assert.rejects(plugin.proto_movies_byId({ id: 999 }), { message: "not_found" });
});

test("search maps rows, skips rows with no release year, and an empty query asks nothing", async () => {
  const calls = fakeKino({ "/search/movie": { results: [{ id: 1, title: "A", release_date: "2000-01-01", vote_average: 7, genre_ids: [28] }, { id: 2, title: "No date", release_date: "" }] } });
  assert.deepEqual(await plugin.proto_movies_search({ q: " a " }), [{ id: 1, title: "A", year: 2000 }], "only the declared Movie fields");
  assert.equal(calls[0].params.query, "a");
  assert.deepEqual(await plugin.proto_movies_search({ q: "  " }), []);
  assert.equal(calls.length, 1);
});

test("trendingReturnsOnlyNewItemsAfterCursor", async () => {
  let week = [{ id: 1, title: "One", release_date: "2000-01-01" }, { id: 2, title: "Two", release_date: "2001-01-01" }];
  fakeKino({ "/trending/movie": () => ({ results: week }) });
  const first = await plugin.proto_movies_trending(null);
  assert.deepEqual(first.items.map((m) => m.id), [1, 2]);
  assert.deepEqual(first.cursor, [1, 2]);
  const again = await plugin.proto_movies_trending(first.cursor);
  assert.deepEqual(again.items, []);
  assert.deepEqual(again.cursor, [1, 2]);
  week = [...week, { id: 3, title: "Three", release_date: "2002-01-01" }];
  const next = await plugin.proto_movies_trending(again.cursor);
  assert.deepEqual(next.items.map((m) => m.id), [3]);
  assert.deepEqual(next.cursor, [1, 2, 3]);
});

test("the trending cursor is bounded and a bad cursor starts over", async () => {
  fakeKino({ "/trending/movie": { results: [{ id: 7, title: "Seven", release_date: "2000-01-01" }] } });
  const big = Array.from({ length: 500 }, (_, i) => 1000 + i);
  const r = await plugin.proto_movies_trending(big);
  assert.equal(r.cursor.length, 200);
  assert.equal(r.cursor.at(-1), 7);
  assert.deepEqual((await plugin.proto_movies_trending("garbage")).items.map((m) => m.id), [7]);
});

test("tmdbErrorsMapToProviderFailed: a short code, never TMDB's or Kino's own text", async () => {
  for (const code of ["no_tmdb_key", "rate_limited", "not_allowed", "timeout", "unavailable"]) {
    fakeKino({ "/movie": withCode(code), "/search": withCode(code), "/trending": withCode(code), "/discover": withCode(code) });
    for (const run of [() => plugin.proto_movies_byId({ id: 1 }), () => plugin.proto_movies_search({ q: "a" }), () => plugin.proto_movies_trending(null), () => plugin.proto_movies_random({})]) {
      await assert.rejects(run(), (e) => e instanceof Error && e.message === code);
    }
  }
  fakeKino({ "/movie": new Error("boom, with a secret detail") });
  await assert.rejects(plugin.proto_movies_byId({ id: 1 }), { message: "unavailable" });
  // A Kino without kino.tmdb (never the case on 0.9.81, which brings the door): unavailable, no throw of another kind.
  globalThis.kino = { lang: "es-CO", config: { get: () => null } };
  await assert.rejects(plugin.proto_movies_search({ q: "a" }), { message: "unavailable" });
});

test("through the app's protocol rules: a consumer gets validated answers, and a failure is provider_failed", async () => {
  const consumer = { id: "consumer-x", name: "Consumer", version: "1.0.0", apiVersion: 20, entry: "plugin.js", hosts: ["example.com"], capabilities: ["search", "resolve"], consumes: { tmdb: { repo: "kinotvapp/kino-plugin-tmdb", door: "movies", calls: ["byId", "random", "search"], streams: ["trending"] } } };
  const checked = validateManifest(JSON.stringify(consumer));
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const protocol = createProtocolCaller({ consumes: protocolBlocks(checked.manifest).consumes, providers: [{ doors: protocolBlocks(rawManifest).provides, plugin }] });
  const consumerKino = createKino(checked.manifest, { protocol }).kino;
  fakeKino({ "/movie": matrix, "/search/movie": { results: [{ id: 603, title: "Matrix", release_date: "1999-03-30", popularity: 99 }] } });
  assert.equal((await consumerKino.plugins.call("tmdb", "byId", { id: 603 })).director, "Lana Wachowski");
  assert.deepEqual(await consumerKino.plugins.call("tmdb", "search", { q: "matrix" }), [{ id: 603, title: "Matrix", year: 1999 }]);
  await assert.rejects(consumerKino.plugins.call("tmdb", "byId", { id: "603" }), { code: "bad_input" });
  fakeKino({ "/movie": withCode("rate_limited") });
  await assert.rejects(consumerKino.plugins.call("tmdb", "byId", { id: 1 }), { code: "provider_failed" });
});

test("with the kit's kino.tmdb and a fixture file: every export answers, the adult row never does", async () => {
  const { kino } = createKino(manifest, { tmdbFixture: join(root, "test", "fixtures", "movies-door.json") });
  globalThis.kino = kino;
  assert.equal((await plugin.proto_movies_byId({ id: 603 })).director, "Lana Wachowski");
  assert.equal((await plugin.proto_movies_random({ fromYear: 1999, toYear: 1999 })).id, 603);
  assert.deepEqual((await plugin.proto_movies_search({ q: "matrix" })).map((m) => m.id), [603]);
  assert.deepEqual((await plugin.proto_movies_trending(null)).items.map((m) => m.id), [603]);
});
