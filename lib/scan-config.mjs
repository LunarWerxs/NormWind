// What NormWind scans, and the ceilings it refuses to cross.
//
// The audit path and the --fix path must agree on every value here, so the
// numbers are declared once rather than beside whichever caller needed them
// first.

// Markup-first formats: a class attribute is the dominant shape, so a single
// bracket-bearing token in one is worth canonicalizing on its own, and `--fix`
// (as opposed to `--fixall`) covers them.
export const MARKUP_EXTENSIONS = new Set([".vue", ".svelte", ".astro", ".html", ".htm"]);
// Tailwind's canonicalizer retains about 0.4 MB of heap per unique candidate
// for the life of its engine, so one engine answers at most this many before
// a fresh one replaces it (lib/canonical-cache.mjs). The heap stays bounded at
// any count; a big codebase just takes a few seconds per thousand.
export const LIVE_CANONICALIZATIONS_PER_ENGINE = 1000;
// Action mode scans an untrusted pull request. Batching bounds memory but not
// time (about 6.5 s per 1,000 on a laptop), so the Action alone keeps a hard
// ceiling well inside its 10-minute timeout.
export const ACTION_MAX_LIVE_CANONICALIZATIONS = 10000;
// A stray large generated file (bundler output, a vendored .js, a data file)
// landing in a non-ignored directory would otherwise be read whole into
// memory alongside every other matched file. Real hand-authored .vue/.tsx
// source is nowhere near this size; anything bigger is almost certainly not
// meant to be linted and is skipped with a log line instead of silently
// eating memory/time.
export const MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;
