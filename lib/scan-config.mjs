// What NormWind scans, and the ceilings it refuses to cross.
//
// The audit path and the --fix path must agree on every value here, so the
// numbers are declared once rather than beside whichever caller needed them
// first.

export const DEFAULT_PATTERNS = ["**/*.{vue,svelte,astro,html,js,mjs,cjs,ts,jsx,tsx,mts,cts}"];
// Markup-first formats: a class attribute is the dominant shape, so a single
// bracket-bearing token in one is worth canonicalizing on its own, and `--fix`
// (as opposed to `--fixall`) covers them.
export const MARKUP_EXTENSIONS = new Set([".vue", ".svelte", ".astro", ".html", ".htm"]);
export const FILE_SCAN_CONCURRENCY = 32;
// Tailwind's unstable canonicalizer grows very quickly with thousands of
// unique cache misses. Fail predictably before a small adversarial source file
// can exhaust the Node heap.
export const MAX_LIVE_CANONICALIZATION_CANDIDATES = 1000;
// A stray large generated file (bundler output, a vendored .js, a data file)
// landing in a non-ignored directory would otherwise be read whole into
// memory alongside every other matched file. Real hand-authored .vue/.tsx
// source is nowhere near this size; anything bigger is almost certainly not
// meant to be linted and is skipped with a log line instead of silently
// eating memory/time.
export const MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;
