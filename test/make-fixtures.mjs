// Writes test/fixtures/tmdb.json: hand-written TMDB answers (no network, no key) in the Node kit's KINO_TMDB_FIXTURE
// format, keyed "<path>?<params sorted by name>" (exact) or "<path>" (any params). Shapes follow TMDB's v3 API.
//   node test/make-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kinoTmdbRequest } from "../sdk/kino-shim.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const key = (path, params) => {
  const { path: p, query } = kinoTmdbRequest(path, params);
  return query ? `${p}?${query}` : p;
};

const MOVIES = [
  [603, "Matrix", "The Matrix", "1999-03-31", [28, 878], 8.2],
  [27205, "El origen", "Inception", "2010-07-15", [28, 878, 12], 8.4],
  [155, "Batman: El caballero de la noche", "The Dark Knight", "2008-07-16", [18, 28, 80], 8.5],
  [157336, "Interestelar", "Interstellar", "2014-11-05", [12, 18, 878], 8.4],
  [680, "Tiempos violentos", "Pulp Fiction", "1994-09-10", [53, 80], 8.5],
  [13, "Forrest Gump", "Forrest Gump", "1994-06-23", [35, 18, 10749], 8.5],
  [129, "El viaje de Chihiro", "千と千尋の神隠し", "2001-07-20", [16, 10751, 14], 8.5],
  [694, "El resplandor", "The Shining", "1980-05-23", [27, 53], 8.2],
];
const SHOWS = [
  [1399, "Juego de tronos", "Game of Thrones", "2011-04-17", [10765, 18, 10759], 8.5],
  [1396, "Breaking Bad", "Breaking Bad", "2008-01-20", [18, 80], 8.9],
  [66732, "Stranger Things", "Stranger Things", "2016-07-15", [18, 10765, 9648], 8.6],
  [1429, "Ataque a los titanes", "進撃の巨人", "2013-04-07", [16, 10765, 10759], 8.7],
  [94605, "Arcane", "Arcane", "2021-11-06", [16, 10765, 10759], 8.7],
  [60625, "Rick y Morty", "Rick and Morty", "2013-12-02", [16, 35, 10765], 8.7],
];
const poster = (id) => `/p${id}.jpg`;
const backdrop = (id) => `/b${id}.jpg`;
const movie = ([id, title, original, date, genres, vote], extra = {}) => ({
  adult: false, id, title, original_title: original, release_date: date, genre_ids: genres, vote_average: vote, vote_count: 20000,
  poster_path: poster(id), backdrop_path: backdrop(id), overview: `Sinopsis de ${title}.`, popularity: 100 - id / 10000, ...extra,
});
const show = ([id, name, original, date, genres, vote], extra = {}) => ({
  id, name, original_name: original, first_air_date: date, genre_ids: genres, vote_average: vote, vote_count: 15000,
  poster_path: poster(id), backdrop_path: backdrop(id), overview: `Sinopsis de ${name}.`, popularity: 90 - id / 10000, ...extra,
});
const page = (results, n = 1, total = 1) => ({ page: n, results, total_pages: total, total_results: results.length * total });

const mixed = [
  movie(MOVIES[0], { media_type: "movie" }), show(SHOWS[0], { media_type: "tv" }), { id: 6384, media_type: "person", name: "Keanu Reeves", known_for: [] },
  movie(MOVIES[1], { media_type: "movie" }),
  show(SHOWS[2], { media_type: "tv" }), movie(MOVIES[0], { media_type: "movie" }), // a repeat: dropped
  movie([999001, "Algo para adultos", "Adult", "2020-01-01", [], 5], { media_type: "movie", adult: true }), // never shown
];

function season(showId, n, count) {
  return {
    season_number: n, name: `Temporada ${n}`,
    episodes: Array.from({ length: count }, (_, i) => ({
      season_number: n, episode_number: i + 1, name: `Capítulo ${n}x${i + 1}`, overview: `Pasa algo en el ${i + 1}.`,
      still_path: `/s${showId}-${n}-${i + 1}.jpg`, air_date: `2011-0${Math.min(9, n)}-1${i}`, runtime: 55 + i,
      crew: [], guest_stars: [],
    })),
  };
}

const got = {
  ...show(SHOWS[0]), genres: [{ id: 10765, name: "Sci-Fi & Fantasy" }, { id: 18, name: "Drama" }],
  number_of_seasons: 2,
  seasons: [
    { season_number: 0, episode_count: 3, name: "Especiales" },
    { season_number: 1, episode_count: 3, name: "Temporada 1" },
    { season_number: 2, episode_count: 2, name: "Temporada 2" },
  ],
  external_ids: { imdb_id: "tt0944947", tvdb_id: 121361 },
  credits: { cast: [{ name: "Emilia Clarke", character: "Daenerys Targaryen", profile_path: "/ec.jpg" }, { name: "Kit Harington", character: "Jon Snow", profile_path: null }] },
  images: { logos: [{ file_path: "/logo-en.png", iso_639_1: "en", vote_average: 5 }, { file_path: "/logo-es.png", iso_639_1: "es", vote_average: 4 }, { file_path: "/logo.svg", iso_639_1: "es", vote_average: 9 }] },
  translations: { translations: [{ iso_639_1: "en", iso_3166_1: "US", data: { name: "Game of Thrones", overview: "Seven noble families fight." } }] },
  "season/1": season(1399, 1, 3),
  "season/2": season(1399, 2, 2),
};

const matrix = {
  ...movie(MOVIES[0]), overview: "", runtime: 136, imdb_id: "tt0133093",
  genres: [{ id: 28, name: "Acción" }, { id: 878, name: "Ciencia ficción" }],
  external_ids: { imdb_id: "tt0133093" },
  credits: { cast: [{ name: "Keanu Reeves", character: "Neo", profile_path: "/kr.jpg" }, { name: "Keanu Reeves", character: "Neo (repeat)" }, { name: "Carrie-Anne Moss", character: "Trinity", profile_path: "/cam.jpg" }] },
  images: { logos: [{ file_path: "/matrix-en.png", iso_639_1: "en", vote_average: 5 }] },
  translations: { translations: [{ iso_639_1: "en", iso_3166_1: "US", data: { title: "The Matrix", overview: "A hacker learns the truth." } }] },
};

const fixtures = {
  "/configuration": { images: { secure_base_url: "https://image.tmdb.org/t/p/" } },
  "/trending/all/day": page(mixed),
  "/trending/all/week": page([...mixed].reverse()),
  "/movie/popular": page(MOVIES.slice(0, 4).map((m) => movie(m)), 1, 3),
  [key("/movie/popular", { region: "CO", language: "es-MX", page: 2 })]: page(MOVIES.slice(4).map((m) => movie(m)), 2, 3),
  [key("/movie/popular", { region: "CO", language: "es-MX", page: 3 })]: page([movie(MOVIES[0]), movie(MOVIES[7])], 3, 3),
  "/tv/popular": page(SHOWS.map((s) => show(s)), 1, 500),
  "/movie/top_rated": page([...MOVIES].reverse().map((m) => movie(m))),
  "/tv/top_rated": page([...SHOWS].reverse().map((s) => show(s))),
  "/movie/now_playing": page(MOVIES.slice(2, 6).map((m) => movie(m))),
  "/tv/on_the_air": page(SHOWS.slice(1, 4).map((s) => show(s))),
  "/tv/airing_today": page(SHOWS.slice(3).map((s) => show(s))),
  "/discover/movie": page(MOVIES.slice(1, 7).map((m) => movie(m)), 1, 10),
  "/discover/tv": page(SHOWS.slice(0, 5).map((s) => show(s)), 1, 10),
  "/search/multi": page(mixed, 1, 2),
  "/person/6384/combined_credits": {
    cast: [movie(MOVIES[0], { media_type: "movie", popularity: 80 }), movie([1880, "John Wick", "John Wick", "2014-10-22", [28, 53], 7.4], { media_type: "movie", popularity: 95 })],
    crew: [movie([77777, "Man of Tai Chi", "Man of Tai Chi", "2013-07-05", [28], 6], { media_type: "movie", job: "Director", popularity: 10 })],
  },
  "/tv/1399": got,
  "/movie/603": matrix,
  "/tv/1396": { ...show(SHOWS[1]), genres: [{ id: 18, name: "Drama" }], seasons: [] },
  "/find/tt0133093": { movie_results: [{ id: 603, title: "Matrix" }], tv_results: [] },
  "/find/tt0944947": { movie_results: [], tv_results: [{ id: 1399, name: "Juego de tronos" }] },
};

mkdirSync(join(root, "test", "fixtures"), { recursive: true });
writeFileSync(join(root, "test", "fixtures", "tmdb.json"), JSON.stringify(fixtures, null, 1) + "\n");
console.log(Object.keys(fixtures).length + " answers written");
