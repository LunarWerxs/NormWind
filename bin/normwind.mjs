#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as bundledBabelParser from "@babel/parser";
import bundledTailwindGroupsModule from "eslint-plugin-tailwindcss/lib/config/groups.js";
import * as bundledTailwind from "tailwindcss";
import bundledTailwindPackage from "tailwindcss/package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundledRequire = createRequire(import.meta.url);

// Single source of truth: npm always includes package.json in the published
// tarball, so the version is read from it rather than duplicated here.
const NORMWINDS_VERSION = bundledRequire("../package.json").version;
const RULE_ID = "tailwindcss/enforces-shorthand";
const DEFAULT_PATTERNS = ["**/*.{vue,js,mjs,ts,jsx,tsx}"];
const ROOT_FONT_SIZE_PX = 16;
const FILE_SCAN_CONCURRENCY = 32;
// Tailwind's unstable canonicalizer grows very quickly with thousands of
// unique cache misses. Fail predictably before a small adversarial source file
// can exhaust the Node heap.
const MAX_LIVE_CANONICALIZATION_CANDIDATES = 1000;
// A stray large generated file (bundler output, a vendored .js, a data file)
// landing in a non-ignored directory would otherwise be read whole into
// memory alongside every other matched file. Real hand-authored .vue/.tsx
// source is nowhere near this size; anything bigger is almost certainly not
// meant to be linted and is skipped with a log line instead of silently
// eating memory/time.
const MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;
const CANONICAL_OUTPUT_JSON = path.resolve(
    process.cwd(),
    "docs/reference/canonical-replacements.json",
);
const CANONICAL_OUTPUT_MD = path.resolve(
    process.cwd(),
    "docs/reference/canonical-replacements.md",
);
const BUNDLED_CANONICAL_JSON = path.resolve(
    PACKAGE_ROOT,
    "docs/reference/canonical-replacements.json",
);
// The ripgrep glob list and the walkDirectory sets below must describe the
// SAME contract — rg additionally honors .gitignore, so anything that relies
// on .gitignore alone would silently diverge on machines without rg.
const RG_IGNORE_GLOBS = [
    "!.git",
    "!.chrome-profile/**",
    "!.chrome-profile-headless/**",
    "!.tmp/**",
    "!.saydeploy/**",
    "!.venv/**",
    "!**/.venv/**",
    "!dist/**",
    "!**/dist/**",
    "!infra/aws/bin/app.js",
    "!node_modules/**",
    "!**/node_modules/**",
    "!test-results/**",
    "!**/test-results/**",
    "!**/cdk.out/**",
];
const IGNORED_SEGMENTS = new Set([".git", ".venv", "cdk.out", "dist", "node_modules", "test-results"]);
const IGNORED_ROOT_PREFIXES = [
    ".chrome-profile/",
    ".chrome-profile-headless/",
    ".tmp/",
    ".saydeploy/",
    "dist/",
    "test-results/",
];
const IGNORED_EXACT_PATHS = new Set(["infra/aws/bin/app.js"]);

const CACHE_FILE = path.resolve(process.cwd(), "node_modules/.cache/normwinds/canonical-cache.json");
const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_FILE_BYTES = 8 * 1024 * 1024;
const ACTION_WORKSPACE_ROOT = process.env.NORMWIND_ACTION_WORKSPACE
    ? path.resolve(process.env.NORMWIND_ACTION_WORKSPACE)
    : null;
const ACTION_MAX_FILES = 20_000;
const ACTION_MAX_TOTAL_SOURCE_BYTES = 256 * 1024 * 1024;
const ACTION_MAX_THEME_FILES = 100;
const ACTION_MAX_THEME_BYTES = 5 * 1024 * 1024;

function isInsidePath(parent, child) {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertInsideActionWorkspace(filePath, label) {
    if (ACTION_WORKSPACE_ROOT && !isInsidePath(ACTION_WORKSPACE_ROOT, filePath)) {
        throw new Error(`normwinds: ${label} escapes the checked-out workspace: ${filePath}`);
    }
}

async function resolveActionSafePath(filePath, label) {
    const realPath = await fs.realpath(filePath);
    assertInsideActionWorkspace(realPath, label);
    return realPath;
}

let tailwindModuleCache = null;

function resolveTailwindRuntime() {
    // Canonicalization must follow the target project's Tailwind semantics.
    // NormWind bundles Tailwind as a zero-config fallback, but using that newer
    // engine against a project pinned to an older v4 release can suggest a
    // named utility whose theme value or availability changed between minors.
    // Resolve from cwd first so local installs, npx runs, and monorepo package
    // directories all use the Tailwind version that will actually build the
    // scanned source.
    if (process.env.NORMWIND_FORCE_BUNDLED_RUNTIME !== "1") {
        try {
            const projectRequire = createRequire(path.resolve(process.cwd(), "package.json"));
            const projectPkg = projectRequire("tailwindcss/package.json");
            const major = Number.parseInt(String(projectPkg?.version ?? "").split(".")[0], 10);
            if (major === 4) {
                return {
                    tailwind: projectRequire("tailwindcss"),
                    tailwindPkg: projectPkg,
                    tailwindRequire: projectRequire,
                    source: "project",
                };
            }
        } catch {
            // A project-local Tailwind install is optional. The bundled engine
            // preserves standalone/global operation and existing zero-config use.
        }
    }

    return {
        tailwind: bundledTailwind,
        tailwindPkg: bundledTailwindPackage,
        tailwindRequire: bundledRequire,
        tailwindIndexCssPath: process.env.NORMWIND_BUNDLED_TAILWIND_CSS || null,
        source: "bundled",
    };
}

function loadTailwind() {
    if (!tailwindModuleCache) {
        const runtime = resolveTailwindRuntime();
        tailwindModuleCache = {
            ...runtime,
            tailwindGroups: bundledTailwindGroupsModule.groups,
        };
    }
    return tailwindModuleCache;
}

let designSystemPromise = null;
async function loadTailwindDesignSystem() {
    if (!designSystemPromise) {
        designSystemPromise = (async () => {
            const { tailwind, tailwindRequire, tailwindIndexCssPath: configuredCssPath } = loadTailwind();
            const tailwindIndexCssPath = configuredCssPath || tailwindRequire.resolve("tailwindcss/index.css");
            const css = await fs.readFile(tailwindIndexCssPath, "utf8");
            const designSystem = await tailwind.__unstable__loadDesignSystem(css, {
                from: tailwindIndexCssPath,
            });
            return { designSystem, tailwindIndexCssPath };
        })();
    }
    return designSystemPromise;
}

// Match `@import "...";` (with or without trailing layer/media clauses).
// Captures the import specifier in group 2. Quotes can be " or '.
const CSS_IMPORT_REGEX = /@import\s+(["'])([^"']+)\1[^;]*;\s*/g;

// True when an @import target is a local file path (`./x`, `../x`, `/x`).
// Anything else (`tailwindcss`, `tailwindcss/preflight`, `@scope/pkg`, URLs)
// is treated as a package/runtime import and dropped — Tailwind's own CSS is
// already prepended by the caller, and other package imports cannot be
// resolved without a real bundler.
function isLocalCssImportSpecifier(spec) {
    return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

async function readThemeCssSource(filePath, budget) {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
        throw new Error(`normwinds: theme CSS path is not a regular file: ${filePath}`);
    }
    if (ACTION_WORKSPACE_ROOT) {
        budget.files += 1;
        budget.bytes += stats.size;
        if (budget.files > ACTION_MAX_THEME_FILES) {
            throw new Error(`normwinds: theme CSS import graph exceeds the Action limit of ${ACTION_MAX_THEME_FILES} files`);
        }
        if (budget.bytes > ACTION_MAX_THEME_BYTES) {
            throw new Error(`normwinds: theme CSS import graph exceeds the Action limit of ${ACTION_MAX_THEME_BYTES} bytes`);
        }
    }
    return fs.readFile(filePath, "utf8");
}

// Recursively inline local @import directives into the source CSS so
// Tailwind's design-system loader sees the project's @theme blocks even when
// they live in files imported from the entry CSS.
async function inlineLocalCssImports(sourceCss, sourcePath, visited, budget) {
    const sourceDir = path.dirname(sourcePath);
    const parts = [];
    let lastIndex = 0;
    // A fresh RegExp per recursion frame is required. Sharing the module-level
    // global instance lets a nested import reset its parent's lastIndex, which
    // can duplicate the CSS between imports and change last-declaration-wins
    // @theme semantics.
    const importRegex = new RegExp(CSS_IMPORT_REGEX.source, CSS_IMPORT_REGEX.flags);

    let match;
    while ((match = importRegex.exec(sourceCss)) !== null) {
        parts.push(sourceCss.slice(lastIndex, match.index));
        lastIndex = importRegex.lastIndex;

        const spec = match[2];
        if (!isLocalCssImportSpecifier(spec)) {
            // Drop package/url imports.
            continue;
        }

        const importedCandidate = path.resolve(sourceDir, spec);
        let importedAbs;
        try {
            importedAbs = ACTION_WORKSPACE_ROOT
                ? await resolveActionSafePath(importedCandidate, `CSS import "${spec}"`)
                : importedCandidate;
        } catch (error) {
            throw new Error(
                `normwinds: failed to resolve CSS import "${spec}" from ${sourcePath}: ${error.message}`,
            );
        }
        if (visited.has(importedAbs)) {
            // Already inlined upstream — silently skip to avoid cycles and
            // duplicate @theme blocks.
            continue;
        }
        visited.add(importedAbs);

        let importedSource;
        try {
            importedSource = await readThemeCssSource(importedAbs, budget);
        } catch (error) {
            throw new Error(
                `normwinds: failed to read CSS import "${spec}" from ${sourcePath}: ${error.message}`,
            );
        }

        const inlined = await inlineLocalCssImports(importedSource, importedAbs, visited, budget);
        parts.push(`/* normwinds inlined: ${importedAbs} */\n${inlined}\n`);
    }

    parts.push(sourceCss.slice(lastIndex));
    return parts.join("");
}

async function resolveThemeCssEntry(themeCssPath) {
    const candidate = path.resolve(process.cwd(), themeCssPath);
    const absPath = ACTION_WORKSPACE_ROOT
        ? await resolveActionSafePath(candidate, "theme CSS entry")
        : candidate;
    const budget = { files: 0, bytes: 0 };
    const entrySource = await readThemeCssSource(absPath, budget);
    const visited = new Set([absPath]);
    const resolvedCss = await inlineLocalCssImports(entrySource, absPath, visited, budget);
    return { absPath, resolvedCss, importedFiles: [...visited] };
}

// Separate cache for the user-augmented design system used by
// --suggest-named-theme-vars. Keyed by the absolute themeCssPath so multiple
// projects in the same Node process never cross-contaminate.
const augmentedDesignSystemPromises = new Map();
async function loadAugmentedDesignSystem(themeCssPath) {
    const absPath = path.resolve(process.cwd(), themeCssPath);
    let promise = augmentedDesignSystemPromises.get(absPath);
    if (!promise) {
        promise = (async () => {
            const { tailwind, tailwindRequire, tailwindIndexCssPath: configuredCssPath } = loadTailwind();
            const tailwindIndexCssPath = configuredCssPath || tailwindRequire.resolve("tailwindcss/index.css");
            const baseCss = await fs.readFile(tailwindIndexCssPath, "utf8");
            const { resolvedCss, importedFiles } = await resolveThemeCssEntry(themeCssPath);

            // Fail loud when the resolved CSS contains no @theme block. Without
            // a project @theme there are no forwarders to detect, so silently
            // returning zero suggestions would mask a misconfiguration. Strip
            // CSS comments first so a comment that mentions "@theme" doesn't
            // satisfy the check.
            const cssWithoutComments = resolvedCss.replace(/\/\*[\s\S]*?\*\//g, "");
            if (!/@theme\b/.test(cssWithoutComments)) {
                throw new Error(
                    `normwinds: --theme-css resolved no @theme block. Inspected ${importedFiles.length} file(s) starting at ${absPath}. Either local @import directives could not be resolved, or the wrong CSS entry was provided.`,
                );
            }

            const css = `${baseCss}\n/* normwinds: --theme-css */\n${resolvedCss}`;
            const themeCssHash = createHash("sha1").update(resolvedCss).digest("hex").slice(0, 12);

            const designSystem = await tailwind.__unstable__loadDesignSystem(css, {
                from: tailwindIndexCssPath,
            });
            return { designSystem, tailwindIndexCssPath, themeCssHash, importedFiles };
        })();
        augmentedDesignSystemPromises.set(absPath, promise);
    }
    return promise;
}

// CANONICAL_MEMO stores token -> canonical (equal to token = no change).
// Pre-populated from on-disk cache; any new entries are persisted on exit.
const CANONICAL_MEMO = new Map();
// Only dynamically-computed entries belong in the writable cache. Snapshot
// entries are already shipped with the package; persisting all 12k+ of them
// again needlessly bloats every consumer project's cache.
const DYNAMIC_CACHE_KEYS = new Set();
let diskCacheDirty = false;
let diskCacheTailwindVersion = null;

function isSafeCacheEntry(key, value) {
    return (
        typeof key === "string" &&
        typeof value === "string" &&
        key.length > 0 &&
        key.length <= 4096 &&
        value.length <= 4096 &&
        !/\s/.test(key) &&
        !/\s/.test(value) &&
        !key.includes("\0") &&
        !/[\0"'`]/.test(value)
    );
}

async function loadDiskCache() {
    if (process.env.NORMWIND_DISABLE_DISK_CACHE === "1") {
        return false;
    }
    try {
        const stats = await fs.stat(CACHE_FILE);
        if (stats.size > MAX_CACHE_FILE_BYTES) {
            diskCacheDirty = true;
            return false;
        }

        const raw = await fs.readFile(CACHE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        const { tailwindPkg } = loadTailwind();
        if (
            parsed &&
            parsed.schema === CACHE_SCHEMA_VERSION &&
            parsed.tailwindVersion === tailwindPkg.version &&
            parsed.entries &&
            typeof parsed.entries === "object"
        ) {
            diskCacheTailwindVersion = parsed.tailwindVersion;
            for (const [k, v] of Object.entries(parsed.entries)) {
                if (isSafeCacheEntry(k, v)) {
                    CANONICAL_MEMO.set(k, v);
                    DYNAMIC_CACHE_KEYS.add(k);
                } else {
                    diskCacheDirty = true;
                }
            }
            return true;
        }
        // Replace stale or malformed caches on the next successful run. Cache
        // version validation happens before entries enter CANONICAL_MEMO so a
        // fully warm, stale cache can never bypass invalidation.
        diskCacheTailwindVersion = tailwindPkg.version;
        diskCacheDirty = true;
    } catch (error) {
        // A missing cache is normal. Replace unreadable/malformed caches after
        // the scan so the same parse failure does not recur forever.
        if (error?.code !== "ENOENT") {
            diskCacheDirty = true;
        }
    }
    return false;
}

async function saveDiskCache() {
    if (process.env.NORMWIND_DISABLE_DISK_CACHE === "1") {
        return;
    }
    if (!diskCacheDirty) {
        return;
    }
    try {
        const { tailwindPkg } = loadTailwind();
        await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
        const entries = Object.create(null);
        for (const key of DYNAMIC_CACHE_KEYS) {
            const value = CANONICAL_MEMO.get(key);
            if (isSafeCacheEntry(key, value)) {
                entries[key] = value;
            }
        }
        const payload = {
            schema: CACHE_SCHEMA_VERSION,
            tailwindVersion: tailwindPkg.version,
            entries,
        };
        const tmpPath = `${CACHE_FILE}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
        try {
            await fs.writeFile(tmpPath, JSON.stringify(payload), {
                encoding: "utf8",
                flag: "wx",
            });
            await fs.rename(tmpPath, CACHE_FILE);
        } catch (error) {
            await fs.rm(tmpPath, { force: true }).catch(() => {});
            throw error;
        }
    } catch {
        // Cache persistence is best-effort — never fail the run.
    }
}

async function loadCanonicalSnapshot() {
    if (process.env.NORMWIND_DISABLE_CANONICAL_SNAPSHOT === "1") {
        return false;
    }

    // GitHub Action scans treat the checkout as hostile input. A repository
    // may carry its own generated snapshot for CLI maintenance commands, but
    // it must never override the Action's signed/tagged bundled reference.
    const paths = ACTION_WORKSPACE_ROOT
        ? [BUNDLED_CANONICAL_JSON]
        : [...new Set([CANONICAL_OUTPUT_JSON, BUNDLED_CANONICAL_JSON])];
    const { tailwindPkg } = loadTailwind();

    for (const snapshotPath of paths) {
        try {
            const raw = await fs.readFile(snapshotPath, "utf8");
            const parsed = JSON.parse(raw);

            if (
                !parsed ||
                parsed.source?.tailwindVersion !== tailwindPkg.version ||
                !Array.isArray(parsed.replacements)
            ) {
                continue;
            }

            for (const replacement of parsed.replacements) {
                if (
                    replacement &&
                    isSafeCacheEntry(replacement.inputClass, replacement.canonicalClass)
                ) {
                    CANONICAL_MEMO.set(replacement.inputClass, replacement.canonicalClass);
                    if (DYNAMIC_CACHE_KEYS.delete(replacement.inputClass)) {
                        diskCacheDirty = true;
                    }
                }
            }

            return true;
        } catch {
            // Try the next snapshot source.
        }
    }

    return false;
}

// Invalidate the in-memory cache if the Tailwind version on disk doesn't match
// the installed one. Cache entries are only valid for the version that created
// them.
function validateCacheAgainstTailwindVersion() {
    if (!diskCacheTailwindVersion) {
        return;
    }
    const { tailwindPkg } = loadTailwind();
    if (diskCacheTailwindVersion !== tailwindPkg.version) {
        CANONICAL_MEMO.clear();
        diskCacheDirty = true;
    }
}

let canonicalizerFnPromise = null;
async function getCanonicalizeCandidate() {
    if (!canonicalizerFnPromise) {
        canonicalizerFnPromise = (async () => {
            // Loading Tailwind is the expensive bit (~1.4s to prime the
            // design system); skip it if everything is in-cache.
            validateCacheAgainstTailwindVersion();
            const { designSystem } = await loadTailwindDesignSystem();
            return (candidate) => {
                if (!candidate || typeof candidate !== "string") {
                    return candidate;
                }
                const cached = CANONICAL_MEMO.get(candidate);
                if (cached !== undefined) {
                    return cached;
                }
                const canonical = typeof designSystem.canonicalizeCandidates === "function"
                    ? designSystem.canonicalizeCandidates([candidate], {
                        rem: ROOT_FONT_SIZE_PX,
                    })?.[0]
                    : candidate;
                const result = (!canonical || /\s/.test(canonical)) ? candidate : canonical;
                CANONICAL_MEMO.set(candidate, result);
                DYNAMIC_CACHE_KEYS.add(candidate);
                diskCacheDirty = true;
                return result;
            };
        })();
    }
    return canonicalizerFnPromise;
}

// Returns canonical from memo only, without loading Tailwind. undefined means
// the token has never been canonicalized and needs the real engine.
function lookupCanonicalFromMemo(candidate) {
    if (!candidate || typeof candidate !== "string") {
        return candidate;
    }
    return CANONICAL_MEMO.get(candidate);
}

// ---------------------------------------------------------------------------
// Named theme-var resolver  (opt-in via --suggest-named-theme-vars)
//
// Detects classes like `border-(--md-sys-color-outline-variant)` and suggests
// `border-outline-variant` *only when* the design system has a theme variable
// (e.g. `--color-outline-variant`) whose value forwards to that root var AND
// the two classes produce byte-identical CSS. This guarantees zero behavioral
// regression for the suggested replacement at the moment of analysis.
// ---------------------------------------------------------------------------

let themeVarResolverPromise = null;
let themeVarResolverThemeCssPath = null;

// rawTokenInput -> resolved replacement string (or the same input when no safe
// replacement exists). Stored alongside CANONICAL_MEMO using a key prefix so
// disk-cache invalidation on Tailwind version change still applies.
const THEME_VAR_CACHE_PREFIX = "themevar:";

function extractParenVarName(utility) {
    // Matches the trailing `(--name)` form, with optional `!` prefix the parser
    // strips earlier and an optional `/<modifier>` suffix (e.g. `/40` opacity).
    // The modifier is preserved verbatim so the resolver can rebuild
    // `border-(--color-ink-400)/40` -> `border-ink-400/40` with byte-identical CSS.
    const m = /^(?<prefix>[a-z][a-z0-9-]*)-\(--(?<name>[a-z0-9-]+)\)(?<modifier>\/[^\s]+)?$/i.exec(utility);
    if (m) {
        return {
            utilityPrefix: m.groups.prefix,
            varName: `--${m.groups.name}`,
            modifier: m.groups.modifier ?? "",
        };
    }
    const b = /^(?<prefix>[a-z][a-z0-9-]*)-\[var\(--(?<name>[a-z0-9-]+)\)\](?<modifier>\/[^\s]+)?$/i.exec(utility);
    if (b) {
        return {
            utilityPrefix: b.groups.prefix,
            varName: `--${b.groups.name}`,
            modifier: b.groups.modifier ?? "",
        };
    }
    return null;
}

// The active resolver's theme-css hash, exposed so the pre-warm step and the
// hot-loop fallback can compute the same per-project cache namespace. Set
// when a resolver successfully loads; null when no theme CSS is in play (the
// resolver then operates against Tailwind's own design system only).
let activeThemeCssHash = null;

function buildThemeVarCacheKey(rawToken, themeCssHash) {
    if (themeCssHash) {
        return `${THEME_VAR_CACHE_PREFIX}${themeCssHash}:${rawToken}`;
    }
    return `${THEME_VAR_CACHE_PREFIX}${rawToken}`;
}

async function getThemeVarResolver({ themeCssPath = null } = {}) {
    // If the caller passes a different themeCssPath than the cached one, drop
    // the cached resolver so we rebuild against the new design system.
    if (themeVarResolverPromise && themeVarResolverThemeCssPath !== themeCssPath) {
        themeVarResolverPromise = null;
    }
    if (!themeVarResolverPromise) {
        themeVarResolverThemeCssPath = themeCssPath;
        themeVarResolverPromise = (async () => {
            validateCacheAgainstTailwindVersion();
            const augmented = themeCssPath
                ? await loadAugmentedDesignSystem(themeCssPath)
                : await loadTailwindDesignSystem();
            const { designSystem } = augmented;
            const themeCssHash = augmented.themeCssHash || null;
            activeThemeCssHash = themeCssHash;

            // Build a map: forwarded-root-var (e.g. `--md-sys-color-outline-variant`)
            // -> Tailwind theme key (e.g. `--color-outline-variant`).
            // Only single-step forwarders of the form `var(--x)` (with optional
            // whitespace) are eligible. Anything more complex is skipped to keep
            // the equivalence check trivial.
            const forwardedToThemeKey = new Map();
            for (const [key, entry] of designSystem.theme.values.entries()) {
                if (!entry || typeof entry.value !== "string") continue;
                const m = /^\s*var\(\s*(--[a-z0-9-]+)\s*\)\s*$/i.exec(entry.value);
                if (!m) continue;
                const forwarded = m[1];
                if (forwardedToThemeKey.has(forwarded)) {
                    // Multiple theme vars forward to the same root var -- ambiguous.
                    forwardedToThemeKey.set(forwarded, null);
                } else {
                    forwardedToThemeKey.set(forwarded, key);
                }
            }

            // Build a quick lookup: theme key -> the single var() it forwards
            // to (e.g. "--color-outline-variant" -> "--md-sys-color-outline-variant").
            // Only single-var forwarders are stored, matching the population logic
            // above. Used by the equivalence check to verify the candidate CSS
            // differs from the original only by substituting `var(--themeKey)`
            // for `var(--forwarded)`.
            const themeKeyToForwarded = new Map();
            for (const [forwarded, themeKey] of forwardedToThemeKey.entries()) {
                if (typeof themeKey === "string") {
                    themeKeyToForwarded.set(themeKey, forwarded);
                }
            }

            return (rawToken) => {
                if (!rawToken || typeof rawToken !== "string") return rawToken;

                const cacheKey = buildThemeVarCacheKey(rawToken, themeCssHash);
                const cached = CANONICAL_MEMO.get(cacheKey);
                if (cached !== undefined) {
                    return cached === "" ? rawToken : cached;
                }

                const recordMiss = () => {
                    CANONICAL_MEMO.set(cacheKey, "");
                    DYNAMIC_CACHE_KEYS.add(cacheKey);
                    diskCacheDirty = true;
                    return rawToken;
                };

                const token = parseFixToken(rawToken);
                const parsed = extractParenVarName(token.utility);
                if (!parsed) return recordMiss();

                // Resolve `parsed.varName` to a Tailwind theme key. Two pathways:
                //   1. Forwarder pattern: user authored a root var that the design
                //      system forwards from a Tailwind-namespaced theme var
                //      (`--color-x: var(--md-sys-color-x)` -> author writes
                //      `--md-sys-color-x`, theme key is `--color-x`).
                //   2. Direct pattern: user authored the theme key itself
                //      (`--color-ink-400` is registered in @theme; author writes
                //      `border-(--color-ink-400)`, theme key is `--color-ink-400`).
                // Both reduce to "theme key whose namespace prefix is dropped to
                // form the named-utility fragment". The Tailwind-generated CSS
                // body is byte-identical for both forms when the candidate is
                // valid, and `candidatesToCss` returns undefined when the
                // candidate is not a valid utility -- so the equivalence check
                // is the safety gate for both pathways.
                let themeKey = forwardedToThemeKey.get(parsed.varName);
                if (!themeKey || typeof themeKey !== "string") {
                    const direct = designSystem.theme.values.get(parsed.varName);
                    if (direct && typeof direct.value === "string") {
                        themeKey = parsed.varName;
                    }
                }
                if (!themeKey || typeof themeKey !== "string") return recordMiss();

                // Theme keys look like `--<namespace>-<fragment>`. Drop the
                // namespace to get the fragment used in named utility classes.
                const fragmentMatch = /^--[a-z0-9]+-(.+)$/i.exec(themeKey);
                if (!fragmentMatch) return recordMiss();
                const fragment = fragmentMatch[1];
                if (!fragment) return recordMiss();

                const candidateUtility = `${parsed.utilityPrefix}-${fragment}${parsed.modifier}`;
                const candidateRaw = buildFixToken({
                    variants: token.variants,
                    utility: candidateUtility,
                    important: token.important,
                });

                let originalCss;
                let candidateCss;
                try {
                    originalCss = designSystem.candidatesToCss([token.raw])?.[0] ?? "";
                    candidateCss = designSystem.candidatesToCss([candidateRaw])?.[0] ?? "";
                } catch {
                    return recordMiss();
                }
                if (!originalCss || !candidateCss) return recordMiss();
                if (!cssRuleBodiesAreEquivalent(originalCss, candidateCss, themeKeyToForwarded)) {
                    return recordMiss();
                }

                CANONICAL_MEMO.set(cacheKey, candidateRaw);
                DYNAMIC_CACHE_KEYS.add(cacheKey);
                diskCacheDirty = true;
                return candidateRaw;
            };
        })();
    }
    return themeVarResolverPromise;
}

function normalizeCssForCompare(css) {
    return String(css).replace(/\s+/g, " ").trim();
}

// Strip the outer selector (everything up to and including the first `{`)
// and the matching closing `}`, leaving only the rule body. Tailwind's
// `candidatesToCss` output for a single class always wraps the declarations
// in exactly one top-level rule.
function extractCssRuleBody(css) {
    const text = String(css ?? "");
    const open = text.indexOf("{");
    if (open < 0) return "";
    const close = text.lastIndexOf("}");
    if (close <= open) return "";
    return normalizeCssForCompare(text.slice(open + 1, close));
}

// Compare two Tailwind-generated CSS rule strings (selectors ignored) under
// the assumption that the only allowed difference is: any `var(--themeKey)`
// reference in the candidate may be expanded to `var(--forwarded)` per the
// design system's @theme forwarder. This treats the candidate as
// runtime-equivalent because `--themeKey: var(--forwarded)` is a CSS custom-
// property forwarder that re-resolves at every use site.
function cssRuleBodiesAreEquivalent(originalCss, candidateCss, themeKeyToForwarded) {
    const a = extractCssRuleBody(originalCss);
    const b = extractCssRuleBody(candidateCss);
    if (!a || !b) return false;
    if (a === b) return true;

    const substituted = b.replace(/var\(\s*(--[a-z0-9-]+)\s*([^)]*)\)/gi, (full, name, rest) => {
        const forwarded = themeKeyToForwarded.get(name);
        if (!forwarded) return full;
        return `var(${forwarded}${rest || ""})`;
    });
    return substituted === a;
}

function lookupThemeVarReplacementFromMemo(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return undefined;
    const cached = CANONICAL_MEMO.get(buildThemeVarCacheKey(rawToken, activeThemeCssHash));
    if (cached === undefined) return undefined;
    return cached === "" ? rawToken : cached;
}

function tokenLooksLikeNamedThemeVarCandidate(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return false;
    // Accept an optional trailing `/<modifier>` (e.g. opacity) and an optional
    // trailing `!` important marker. Both forms are valid Tailwind syntax and
    // must round-trip through the resolver to keep parity between
    // `border-(--color-x)/40` and `border-x/40`.
    return (
        /-\(--[a-z0-9-]+\)(?:\/[^\s!]+)?!?$/i.test(rawToken) ||
        /-\[var\(--[a-z0-9-]+\)\](?:\/[^\s!]+)?!?$/i.test(rawToken)
    );
}

const KNOWN_CANONICAL_UTILITY_REPLACEMENTS = new Map([
    [["break", "words"].join("-"), ["wrap", "break", "word"].join("-")],
]);

function getKnownCanonicalClass(raw) {
    if (!raw || typeof raw !== "string") {
        return null;
    }

    const token = parseFixToken(raw);
    const utility = KNOWN_CANONICAL_UTILITY_REPLACEMENTS.get(token.utility);
    if (!utility) {
        return null;
    }

    return buildFixToken({
        variants: token.variants,
        utility,
        important: token.important,
    });
}

const COMPLEX_EQUIVALENCES = {
    placeContentOptions: [
        "center",
        "start",
        "end",
        "between",
        "around",
        "evenly",
        "baseline",
        "stretch",
    ],
    placeItemsOptions: ["start", "end", "center", "stretch"],
    placeSelfOptions: ["auto", "start", "end", "center", "stretch"],
};

function buildShorthandFamilies(groups) {
    const targetTypes = new Set([
        "Layout",
        "Flexbox & Grid",
        "Spacing",
        "Sizing",
        "Borders",
        "Tables",
        "Transforms",
        "Typography",
    ]);

    const families = [];

    for (const group of groups) {
        if (!targetTypes.has(group.type) || !Array.isArray(group.members)) {
            continue;
        }

        for (const parent of group.members) {
            if (!Array.isArray(parent.members)) {
                continue;
            }

            const entries = parent.members
                .filter((entry) => entry && typeof entry.body === "string" && typeof entry.shorthand === "string")
                .map((entry) => ({ body: entry.body, shorthand: entry.shorthand }));

            if (entries.length < 2) {
                continue;
            }

            const shorthandToBody = new Map();
            for (const entry of entries) {
                shorthandToBody.set(entry.shorthand, entry.body);
            }

            families.push({
                group: group.type,
                parent: parent.type,
                entries: [...entries].sort((a, b) => b.body.length - a.body.length),
                shorthandToBody,
                supportsCorners: entries.some((entry) => ["tl", "tr", "br", "bl"].includes(entry.shorthand)),
            });
        }
    }

    return families;
}

let shorthandFamiliesCache = null;
let familyBodyIndexCache = null;
function getShorthandFamilies() {
    if (!shorthandFamiliesCache) {
        const { tailwindGroups } = loadTailwind();
        shorthandFamiliesCache = buildShorthandFamilies(tailwindGroups);
        familyBodyIndexCache = buildFamilyBodyIndex(shorthandFamiliesCache);
    }
    return { families: shorthandFamiliesCache, bodyIndex: familyBodyIndexCache };
}

const UTILITY_BODY_CANDIDATES_CACHE = new Map();

const KNOWN_FLAGS = new Set([
    "--check-canonical",
    "--cleanup-canonical-files",
    "--dry-run",
    "--extract-canonical",
    "--fix",
    "--fixall",
    "--help",
    "-h",
    "--json",
    "--suggest-named-theme-vars",
    "--theme-css",
    "--version",
    "-v",
    "--write-canonical-files",
]);
const VALUE_FLAGS = new Set(["--theme-css"]);

function parseArgs(argv) {
    const flags = new Set();
    const patterns = [];
    const valueFlags = Object.create(null);
    const unknownFlags = [];
    const missingValueFlags = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg.startsWith("--")) {
            // Support `--key=value` and `--key value` for value-bearing flags.
            const eqIdx = arg.indexOf("=");
            if (eqIdx > 0) {
                const key = arg.slice(0, eqIdx);
                if (!KNOWN_FLAGS.has(key)) {
                    unknownFlags.push(key);
                    continue;
                }
                valueFlags[key] = arg.slice(eqIdx + 1);
                flags.add(key);
                continue;
            }

            if (!KNOWN_FLAGS.has(arg)) {
                unknownFlags.push(arg);
                continue;
            }

            if (VALUE_FLAGS.has(arg)) {
                if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
                    valueFlags[arg] = argv[i + 1];
                    flags.add(arg);
                    i += 1;
                } else {
                    missingValueFlags.push(arg);
                }
                continue;
            }

            flags.add(arg);
            continue;
        }

        // Single-dash aliases (-h, -v). Anything else starting with "-" is a
        // typo'd flag, not a file pattern — surface it instead of silently
        // scanning nothing.
        if (arg.startsWith("-") && arg.length > 1) {
            if (KNOWN_FLAGS.has(arg)) {
                flags.add(arg);
            } else {
                unknownFlags.push(arg);
            }
            continue;
        }

        patterns.push(arg);
    }

    return {
        checkCanonical: flags.has("--check-canonical"),
        cleanupCanonicalFiles: flags.has("--cleanup-canonical-files"),
        dryRun: flags.has("--dry-run"),
        extractCanonical: flags.has("--extract-canonical"),
        fix: flags.has("--fix") || flags.has("--fixall"),
        fixAll: flags.has("--fixall"),
        help: flags.has("--help") || flags.has("-h"),
        json: flags.has("--json"),
        suggestNamedThemeVars: flags.has("--suggest-named-theme-vars"),
        themeCssPath: valueFlags["--theme-css"] || null,
        version: flags.has("--version") || flags.has("-v"),
        writeCanonicalFiles: flags.has("--write-canonical-files"),
        patterns,
        unknownFlags,
        missingValueFlags,
    };
}

function printHelp() {
    console.log(`normwinds v${NORMWINDS_VERSION} - Tailwind shorthand audit + safe autofix

Usage:
  normwinds [patterns...] [flags]

Patterns:
  Positional arguments may be file paths, directories, or globs
  (e.g. \`normwinds src\`, \`normwinds "src/**/*.vue"\`, \`normwinds App.tsx\`).
  With no patterns, the default scan is **/*.{vue,js,mjs,ts,jsx,tsx} from the
  current directory, skipping .git, node_modules, dist, test-results, cdk.out
  and other build/scratch folders.

Exit codes:
  0 no findings   1 findings reported   2 usage or runtime error

Flags:
  --fix                       Auto-fix supported transforms in .vue files
  --fixall                    Auto-fix in all matched files (.vue/.js/.mjs/.ts/.jsx/.tsx)
  --dry-run                   With --fix/--fixall, show which files WOULD be
                              rewritten without writing anything to disk.
  --json                      Emit findings as JSON
  --suggest-named-theme-vars  (opt-in, audit only) Emit findings that suggest
                              replacing \`utility-(--var)\` and
                              \`utility-[var(--var)]\` with the named-utility
                              form (e.g. \`utility-name\`) when the project's
                              @theme registers \`--var\` directly or forwards to
                              it. Requires --theme-css. During --fix/--fixall,
                              the same replacements are applied automatically
                              whenever --theme-css is set; safety is gated by
                              per-token CSS equivalence.
  --theme-css <path>          Path to the project's Tailwind entry CSS that
                              contains the @theme block. Used to detect
                              registered theme variables and forwarders.
  --extract-canonical         (maintenance) Rebuild the canonical replacement
                              reference data.
  --check-canonical           (CI) Exit non-zero if the bundled canonical
                              replacement artifacts are stale relative to the
                              installed Tailwind version.
  --write-canonical-files     Persist the extracted reference data to
                              docs/reference/canonical-replacements.{json,md}
  --cleanup-canonical-files   Remove the persisted reference data
  -v, --version               Print the normwinds version and exit
  -h, --help                  Show this help and exit
`);
}

function buildFamilyBodyIndex(families) {
    const index = new Map();

    for (const family of families) {
        for (const entry of family.entries) {
            if (!index.has(entry.body)) {
                index.set(entry.body, []);
            }

            index.get(entry.body).push({
                family,
                shorthand: entry.shorthand,
            });
        }
    }

    return index;
}

async function safeUnlink(filePath) {
    try {
        await fs.unlink(filePath);
    } catch {
        // Ignore missing-file and permission edge cases for cleanup mode.
    }
}

async function cleanupCanonicalArtifacts() {
    await safeUnlink(CANONICAL_OUTPUT_JSON);
    await safeUnlink(CANONICAL_OUTPUT_MD);
}

function toFixedTrim(value) {
    const asString = Number(value.toFixed(6)).toString();
    return asString === "-0" ? "0" : asString;
}

function parseSingleLength(input) {
    const normalized = String(input ?? "").trim();
    const match = normalized.match(/^(-?\d*\.?\d+)(rem|px|em|%)$/i);
    if (!match) {
        return null;
    }

    return {
        number: Number(match[1]),
        unit: match[2].toLowerCase(),
    };
}

function multiplyLength(lengthValue, factor) {
    const parsed = parseSingleLength(lengthValue);
    if (!parsed || Number.isNaN(factor)) {
        return null;
    }

    const multiplied = parsed.number * factor;
    return `${toFixedTrim(multiplied)}${parsed.unit}`;
}

function remToPx(lengthValue, remPx = ROOT_FONT_SIZE_PX) {
    const parsed = parseSingleLength(lengthValue);
    if (!parsed || parsed.unit !== "rem") {
        return null;
    }

    return `${toFixedTrim(parsed.number * remPx)}px`;
}

function pxToRem(lengthValue, remPx = ROOT_FONT_SIZE_PX) {
    const parsed = parseSingleLength(lengthValue);
    if (!parsed || parsed.unit !== "px" || remPx === 0) {
        return null;
    }

    return `${toFixedTrim(parsed.number / remPx)}rem`;
}

function expandValueVariants(value) {
    const variants = new Set([value]);

    const px = remToPx(value);
    if (px) {
        variants.add(px);
    }

    const rem = pxToRem(value);
    if (rem) {
        variants.add(rem);
    }

    return [...variants];
}

function extractFractionPercent(fraction) {
    if (!fraction || !fraction.includes("/")) {
        return null;
    }

    const [leftRaw, rightRaw] = fraction.split("/");
    const left = Number(leftRaw);
    const right = Number(rightRaw);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) {
        return null;
    }

    return `${toFixedTrim((left / right) * 100)}%`;
}

function collectCanonicalCandidateValues({ cssRule, parsedCandidate, themeValueMap }) {
    const values = new Set();

    if (parsedCandidate?.value?.fraction) {
        const percent = extractFractionPercent(parsedCandidate.value.fraction);
        if (percent) {
            values.add(percent);
        }
    }

    if (parsedCandidate?.value?.value?.includes("/")) {
        const percent = extractFractionPercent(parsedCandidate.value.value);
        if (percent) {
            values.add(percent);
        }
    }

    for (const match of cssRule.matchAll(/var\(--([a-z0-9-]+)\)/gi)) {
        const key = `--${match[1]}`;
        const resolved = themeValueMap.get(key);
        if (resolved) {
            values.add(String(resolved).trim());
        }
    }

    const spacingBase = themeValueMap.get("--spacing");
    if (spacingBase) {
        for (const match of cssRule.matchAll(/calc\(var\(--spacing\)\s*\*\s*(-?\d*\.?\d+)\)/gi)) {
            const factor = Number(match[1]);
            const resolved = multiplyLength(spacingBase, factor);
            if (resolved) {
                values.add(resolved);
            }
        }
    }

    for (const match of cssRule.matchAll(/\b(-?\d*\.?\d+(?:deg|rad|turn))\b/gi)) {
        values.add(match[1]);
    }

    for (const match of cssRule.matchAll(/\b(-?\d*\.?\d+%)\b/g)) {
        values.add(match[1]);
    }

    return [...values].filter(Boolean);
}

function addCanonicalReplacement(replacements, inputClass, canonicalClass, sourceClass) {
    const key = `${inputClass}=>${canonicalClass}`;
    if (!replacements.has(key)) {
        replacements.set(key, {
            inputClass,
            canonicalClass,
            sourceClass,
        });
    }
}

async function extractCanonicalReplacements({ writeFiles, checkOnly = false }) {
    const { designSystem, tailwindIndexCssPath } = await loadTailwindDesignSystem();
    const { tailwindPkg } = loadTailwind();
    if (typeof designSystem.canonicalizeCandidates !== "function") {
        throw new Error(
            `normwinds: Tailwind ${tailwindPkg.version} does not expose the canonicalization API required by --extract-canonical/--check-canonical`,
        );
    }

    const classList = designSystem.getClassList().map(([className]) => className);
    const themeValueMap = new Map();
    for (const [key, entry] of designSystem.theme.values.entries()) {
        if (entry && typeof entry.value === "string") {
            themeValueMap.set(key, entry.value);
        }
    }

    const replacementMap = new Map();

    for (const canonicalClass of classList) {
        if (canonicalClass.includes("[") || canonicalClass.includes("]") || canonicalClass.includes(":")) {
            continue;
        }

        const parsedCandidates = designSystem.parseCandidate(canonicalClass);
        if (!Array.isArray(parsedCandidates) || parsedCandidates.length !== 1) {
            continue;
        }

        const parsed = parsedCandidates[0];
        if (parsed?.kind !== "functional" || parsed?.value?.kind !== "named") {
            continue;
        }

        const cssRule = designSystem.candidatesToCss([canonicalClass])?.[0] ?? "";
        if (!cssRule) {
            continue;
        }

        const candidateValues = collectCanonicalCandidateValues({
            cssRule,
            parsedCandidate: parsed,
            themeValueMap,
        });

        if (candidateValues.length === 0) {
            continue;
        }

        for (const candidateValue of candidateValues) {
            for (const valueVariant of expandValueVariants(candidateValue)) {
                // Tailwind source classes encode spaces inside arbitrary values
                // as underscores. Literal-space keys can never be looked up
                // after class strings are tokenized on whitespace.
                const encodedValue = valueVariant.replace(/\s+/g, "_");
                const inputClass = `${parsed.root}-[${encodedValue}]`;
                const canonicalized = designSystem.canonicalizeCandidates([inputClass], {
                    rem: ROOT_FONT_SIZE_PX,
                })?.[0] ?? inputClass;

                if (canonicalized === inputClass) {
                    continue;
                }

                addCanonicalReplacement(replacementMap, inputClass, canonicalized, canonicalClass);
            }
        }
    }

    const replacements = [...replacementMap.values()].sort(
        (a, b) =>
            a.canonicalClass.localeCompare(b.canonicalClass) ||
            a.inputClass.localeCompare(b.inputClass),
    );

    const payload = {
        source: {
            engine: "tailwindcss.designSystem.canonicalizeCandidates",
            tailwindVersion: tailwindPkg.version,
            // Stored relative to the package root so the committed artifact is
            // byte-identical across machines and checkout locations; an
            // absolute path here would fail --check-canonical on every other
            // machine. toolVersion is intentionally omitted for the same
            // reason: the snapshot's identity is the Tailwind version plus the
            // replacement set, not the tool release that generated it.
            tailwindIndexCssPath: path
                .relative(PACKAGE_ROOT, tailwindIndexCssPath)
                .replace(/\\/g, "/"),
            rootFontSizePx: ROOT_FONT_SIZE_PX,
        },
        totals: {
            classListCount: classList.length,
            replacementCount: replacements.length,
        },
        replacements,
    };

    const topExamples = replacements.slice(0, 25);
    const roundedExample = replacements.find(
        (entry) =>
            entry.inputClass === "rounded-[24px]" && entry.canonicalClass === "rounded-3xl",
    );

    const markdownLines = [
        "# Tailwind Canonical Replacements (Generated)",
        "",
        "This file is generated from Tailwind's canonicalization engine.",
        "",
        "- Source engine: `tailwindcss.designSystem.canonicalizeCandidates`",
        `- Tailwind version: \`${tailwindPkg.version}\``,
        `- Class list scanned: \`${classList.length}\``,
        `- Canonical replacements extracted: \`${replacements.length}\``,
        "",
        "## Drift Prevention",
        "",
        "Regenerate this catalog whenever Tailwind is upgraded:",
        "",
        "```bash",
        "npm run canonical:extract",
        "```",
        "",
        "Recommended CI gate:",
        "",
        "```bash",
        "npm run canonical:check",
        "```",
        "",
        "## Verified Example",
        "",
    ];

    if (roundedExample) {
        markdownLines.push(
            `- \`${roundedExample.inputClass}\` -> \`${roundedExample.canonicalClass}\``,
            "",
        );
    } else {
        markdownLines.push("- `rounded-[24px]` mapping was not found in this extraction run.", "");
    }

    markdownLines.push("## Sample Replacements", "", "| Input | Canonical |", "| --- | --- |");
    for (const example of topExamples) {
        markdownLines.push(`| \`${example.inputClass}\` | \`${example.canonicalClass}\` |`);
    }

    markdownLines.push(
        "",
        "For the full machine-readable list, see:",
        "",
        "- `docs/reference/canonical-replacements.json`",
    );

    const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
    const markdownText = `${markdownLines.join("\n")}\n`;

    if (checkOnly) {
        const [existingJson, existingMarkdown] = await Promise.all([
            fs.readFile(CANONICAL_OUTPUT_JSON, "utf8").catch(() => null),
            fs.readFile(CANONICAL_OUTPUT_MD, "utf8").catch(() => null),
        ]);

        // Tolerate CRLF in the on-disk copies: git's autocrlf hands the
        // committed artifacts to us with CRLF on Windows checkouts, and the
        // drift check must not fail over line endings the tool didn't write.
        const normalizeEol = (text) => (text === null ? null : text.replace(/\r\n/g, "\n"));

        if (normalizeEol(existingJson) !== jsonText || normalizeEol(existingMarkdown) !== markdownText) {
            console.error("normwinds: canonical replacement artifacts are out of date.");
            console.error("Run `normwind --extract-canonical --write-canonical-files` and commit the generated files.");
            process.exitCode = 1;
            return;
        }

        console.log(`normwinds v${NORMWINDS_VERSION}: canonical replacement artifacts are up to date.`);
        return;
    }

    console.log(`normwinds v${NORMWINDS_VERSION}: extracted ${replacements.length} canonical replacement(s).`);

    if (writeFiles) {
        await fs.mkdir(path.dirname(CANONICAL_OUTPUT_JSON), { recursive: true });
        await fs.writeFile(CANONICAL_OUTPUT_JSON, jsonText, "utf8");
        await fs.writeFile(CANONICAL_OUTPUT_MD, markdownText, "utf8");
        console.log(`  wrote ${path.relative(process.cwd(), CANONICAL_OUTPUT_JSON)}`);
        console.log(`  wrote ${path.relative(process.cwd(), CANONICAL_OUTPUT_MD)}`);
        return;
    }

    console.log("  files were not written (use --write-canonical-files to persist artifacts)");
}

function toRelative(filePath) {
    // Forward slashes regardless of platform so findings' filePath is stable
    // for CI tooling and matches normalizeRelativePath's convention.
    const relative = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
    return relative || filePath;
}

function maybePushFinding(found, entry) {
    const key = `${entry.filePath}:${entry.line}:${entry.column}:${entry.message}`;
    if (!found.has(key)) {
        found.set(key, entry);
    }
}

function parseClassToken(raw) {
    let utilityPart = raw;
    const importantSuffix = utilityPart.endsWith("!") && utilityPart.length > 1;
    if (importantSuffix) {
        utilityPart = utilityPart.slice(0, -1);
    }

    let importantPrefix = utilityPart.startsWith("!") && utilityPart.length > 1;
    if (importantPrefix) {
        utilityPart = utilityPart.slice(1);
    }

    const lastColon = utilityPart.lastIndexOf(":");
    const variants = lastColon >= 0 ? utilityPart.slice(0, lastColon + 1) : "";
    let utility = lastColon >= 0 ? utilityPart.slice(lastColon + 1) : utilityPart;

    if (!importantPrefix && utility.startsWith("!") && utility.length > 1) {
        importantPrefix = true;
        utility = utility.slice(1);
    }

    return {
        raw,
        variants,
        utility,
        importantPrefix,
        importantSuffix,
        important: importantPrefix || importantSuffix,
    };
}

const TAILWIND_BAD_CHARS_RAW = /[=><&|?,'"`*]/;
const TAILWIND_BAD_CHARS_UTIL = /[=><&|?*]/;
const TAILWIND_UTIL_SHAPE = /^-?[a-z][a-z0-9-]*(?:-[^\s]+)+$/;

function isLikelyTailwindUtility(token) {
    if (!token || !token.utility) {
        return false;
    }

    // Strip arbitrary-value / theme-var bracket contents before the operator
    // gates, so a bracket-variant utility (e.g. `data-[state=open]:bg-red-500`,
    // `[&>svg]:size-4`) is not rejected by an `=`/`>`/`&` that only appears
    // INSIDE the brackets. This mirrors isLikelyFixUtility exactly, so the audit
    // path and the --fixall path agree on which tokens are Tailwind utilities —
    // otherwise --fixall would rewrite bracket-variant tokens the audit never
    // reported.
    if (
        TAILWIND_BAD_CHARS_RAW.test(stripBracketedSegments(token.raw)) ||
        TAILWIND_BAD_CHARS_UTIL.test(stripBracketedSegments(token.utility))
    ) {
        return false;
    }

    if (!token.utility.includes("-")) {
        return token.utility === "border";
    }

    return TAILWIND_UTIL_SHAPE.test(token.utility);
}

function formatClass(variants, important, utility) {
    return `${variants}${utility}${important ? "!" : ""}`;
}

function matchUtilityToBody(utility, body) {
    if (utility === body) {
        return { negative: "", value: "" };
    }

    if (utility.startsWith(`${body}-`)) {
        return { negative: "", value: utility.slice(body.length + 1) };
    }

    if (utility.startsWith(`-${body}-`)) {
        return { negative: "-", value: utility.slice(body.length + 2) };
    }

    return null;
}

function parseFixToken(raw) {
    let token = raw;
    if (token.startsWith("!") && !token.endsWith("!")) {
        token = `${token.slice(1)}!`;
    } else if (!token.startsWith("!") && !token.endsWith("!")) {
        const colonIdx = token.lastIndexOf(":");
        if (colonIdx >= 0) {
            const afterColon = token.slice(colonIdx + 1);
            if (afterColon.startsWith("!") && afterColon.length > 1) {
                token = `${token.slice(0, colonIdx + 1)}${afterColon.slice(1)}!`;
            }
        }
    }

    const important = token.endsWith("!");
    const withoutImportant = important ? token.slice(0, -1) : token;
    const lastColon = withoutImportant.lastIndexOf(":");
    const variants = lastColon >= 0 ? withoutImportant.slice(0, lastColon + 1) : "";
    const utility = lastColon >= 0 ? withoutImportant.slice(lastColon + 1) : withoutImportant;

    return {
        raw: token,
        variants,
        utility,
        important,
    };
}

function buildFixToken({ variants, utility, important }) {
    return `${variants}${utility}${important ? "!" : ""}`;
}

// Strip the contents of every `[...]` and `(...)` segment so that operator
// characters which are valid inside Tailwind arbitrary-value or theme-var
// brackets (e.g. `data-[state=open]`, `[&>svg]`, `(--my-var)`) are not
// mistaken for JSX/JS expression syntax outside the brackets.
function stripBracketedSegments(input) {
    if (typeof input !== "string" || input.length === 0) {
        return input ?? "";
    }

    // Depth-aware scan: Tailwind arbitrary values can nest same-kind brackets
    // (named grid lines, e.g. `grid-cols-[1fr_[full]_1fr]`), which a
    // non-nesting regex only strips up to the first closer, leaving a stray
    // `]` behind. An unbalanced opener keeps its remainder verbatim so the
    // operator gates still see whatever a malformed token contains.
    let out = "";
    let depth = 0;
    let openChar = null;
    let segmentStart = -1;

    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (depth === 0) {
            out += ch;
            if (ch === "[" || ch === "(") {
                depth = 1;
                openChar = ch;
                segmentStart = i;
            }
            continue;
        }

        if (ch === openChar) {
            depth += 1;
        } else if (ch === (openChar === "[" ? "]" : ")")) {
            depth -= 1;
            if (depth === 0) {
                out += ch;
                openChar = null;
                segmentStart = -1;
            }
        }
    }

    if (depth > 0 && segmentStart >= 0) {
        out += input.slice(segmentStart + 1);
    }

    return out;
}

function isLikelyFixUtility(raw) {
    if (!raw) {
        return false;
    }

    // Operator characters are only disqualifying when they appear OUTSIDE of
    // arbitrary-value brackets. Tokens like `data-[state=open]:bg-red-500`,
    // `[&>svg]:size-4`, or `border-(--color-x)/40` are all legitimate
    // Tailwind utilities and must not be filtered out here.
    const stripped = stripBracketedSegments(raw);
    if (/[=><&|?,'"`*]/.test(stripped)) {
        return false;
    }

    const token = parseFixToken(raw);
    if (!token.utility.includes("-")) {
        return token.utility === "border";
    }

    return /^-?[a-z][a-z0-9-]*(?:-[^\s]+)+$/.test(token.utility);
}

// Shared with the audit-side matchUtilityToBody (same function, no drift). It
// also matches the bare-body case (`utility === body`, value ""), which is
// only ever reached with a real bare-valid Tailwind body like `border`
// (`shorthand: 'all'` in the tailwind group data). mergeFixFamilyShorthand
// builds its target the way the audit's buildTarget does (no dash when the
// value is empty), and mergeFixWidthHeight only pairs compound `w-`/`h-`
// utilities, so the "" case never produces a dangling `-` suffix.
const matchFixBodyValue = matchUtilityToBody;

// The merge rules detectFamilyShorthand checks, in the order it checks them:
// axis pairs toward "all", side pairs toward their axis, corner pairs toward
// their side, then the complete four-sides set toward "all". A rule only
// applies when the family defines the target shorthand, which is also why the
// corner rules can never fire outside the border-radius family.
const FIX_FAMILY_MERGE_RULES = [
    { sources: ["x", "y"], target: "all" },
    { sources: ["l", "r"], target: "x" },
    { sources: ["t", "b"], target: "y" },
    { sources: ["tl", "tr"], target: "t" },
    { sources: ["tr", "br"], target: "r" },
    { sources: ["bl", "br"], target: "b" },
    { sources: ["tl", "bl"], target: "l" },
    { sources: ["t", "r", "b", "l"], target: "all" },
];

// Locate the first family merge the audit would report for the current token
// list. Tokens are clustered exactly the way detectFamilyShorthand clusters
// them — per family, per variant prefix + important flag + negative sign +
// value — and each present shorthand keeps the first token that provides it.
function findFamilyMerge(tokens) {
    const { bodyIndex } = getShorthandFamilies();
    const familyClusters = new Map();

    for (let i = 0; i < tokens.length; i += 1) {
        const token = parseFixToken(tokens[i]);
        for (const candidateBody of getUtilityBodyCandidates(token.utility)) {
            const matches = bodyIndex.get(candidateBody);
            if (!matches) {
                continue;
            }

            const matched = matchFixBodyValue(token.utility, candidateBody);
            if (!matched) {
                continue;
            }

            for (const { family, shorthand } of matches) {
                if (!familyClusters.has(family)) {
                    familyClusters.set(family, new Map());
                }

                const clusters = familyClusters.get(family);
                const clusterKey = `${token.variants}|${token.important ? "1" : "0"}|${matched.negative}|${matched.value}`;
                if (!clusters.has(clusterKey)) {
                    clusters.set(clusterKey, {
                        negative: matched.negative,
                        value: matched.value,
                        shorthandIndices: new Map(),
                    });
                }

                const { shorthandIndices } = clusters.get(clusterKey);
                if (!shorthandIndices.has(shorthand)) {
                    shorthandIndices.set(shorthand, i);
                }
            }
        }
    }

    for (const [family, clusters] of familyClusters.entries()) {
        for (const { negative, value, shorthandIndices } of clusters.values()) {
            for (const rule of FIX_FAMILY_MERGE_RULES) {
                const targetBody = family.shorthandToBody.get(rule.target);
                if (!targetBody) {
                    continue;
                }

                const indices = rule.sources.map((shorthand) => shorthandIndices.get(shorthand));
                if (indices.some((index) => index === undefined)) {
                    continue;
                }

                return {
                    indices: [...indices].sort((a, b) => a - b),
                    targetUtility: `${negative}${targetBody}${value ? `-${value}` : ""}`,
                };
            }
        }
    }

    return null;
}

// Fix-side mirror of detectFamilyShorthand: apply the family merges the audit
// reports, one at a time, reclustering after each so a merged token can feed
// the next rule (rounded-tl + rounded-tr -> rounded-t, border-y + border-x ->
// border). Every merge removes at least one token, so the loop terminates.
function mergeFixFamilyShorthand(tokens) {
    let changed = false;

    for (let merge = findFamilyMerge(tokens); merge; merge = findFamilyMerge(tokens)) {
        const { indices, targetUtility } = merge;
        const base = parseFixToken(tokens[indices[0]]);
        const targetRaw = buildFixToken({
            variants: base.variants,
            utility: targetUtility,
            important: base.important,
        });

        const consumed = new Set(indices);
        const existingTarget = tokens.some((token, index) => {
            if (consumed.has(index)) {
                return false;
            }

            const parsed = parseFixToken(token);
            return (
                parsed.variants === base.variants &&
                parsed.important === base.important &&
                parsed.utility === targetUtility
            );
        });

        // Preserve the position of the earliest source token so unrelated
        // utilities keep their relative order in the output.
        tokens[indices[0]] = targetRaw;
        for (let k = indices.length - 1; k >= 1; k -= 1) {
            tokens.splice(indices[k], 1);
        }

        if (existingTarget) {
            tokens.splice(indices[0], 1);
        }

        changed = true;
    }

    return changed;
}

function mergeFixWidthHeight(tokens) {
    let changed = false;

    // Match a `w-X`/`h-X` pair regardless of authoring order. The previous
    // implementation only collapsed `w-X h-X`, silently leaving any
    // `h-X w-X` pair behind because the inner loop scanned forward from the
    // width index. We now scan every position for the first axis token and
    // pair it with any matching counterpart anywhere else in the array.
    for (let i = 0; i < tokens.length; i += 1) {
        const a = parseFixToken(tokens[i]);
        const aWidth = matchFixBodyValue(a.utility, "w");
        const aHeight = matchFixBodyValue(a.utility, "h");
        const aMatch = aWidth ?? aHeight;
        if (!aMatch || aMatch.negative) {
            continue;
        }
        const counterpartBody = aWidth ? "h" : "w";

        for (let j = 0; j < tokens.length; j += 1) {
            if (j === i) {
                continue;
            }
            const b = parseFixToken(tokens[j]);
            const bMatch = matchFixBodyValue(b.utility, counterpartBody);
            if (!bMatch || bMatch.negative) {
                continue;
            }

            if (
                a.variants !== b.variants ||
                a.important !== b.important ||
                aMatch.value !== bMatch.value
            ) {
                continue;
            }

            const targetUtility = `size-${aMatch.value}`;
            const targetRaw = buildFixToken({
                variants: a.variants,
                utility: targetUtility,
                important: a.important,
            });

            // Preserve the position of the earlier token so unrelated
            // utilities keep their relative order in the output.
            const firstIdx = Math.min(i, j);
            const secondIdx = Math.max(i, j);

            const existingTarget = tokens.some((token, index) => {
                if (index === firstIdx || index === secondIdx) {
                    return false;
                }

                const parsed = parseFixToken(token);
                return (
                    parsed.variants === a.variants &&
                    parsed.important === a.important &&
                    parsed.utility === targetUtility
                );
            });

            tokens[firstIdx] = targetRaw;
            tokens.splice(secondIdx, 1);

            if (existingTarget) {
                tokens.splice(firstIdx, 1);
            }

            changed = true;
            i = -1;
            break;
        }
    }

    return changed;
}

function looksLikeFixableClassString(content, { allowSingleTokenCanonical = false } = {}) {
    // Operator characters that hint at JSX/JS expressions are only
    // disqualifying when they appear OUTSIDE of Tailwind's arbitrary-value
    // brackets (`[...]`) or theme-var parens (`(...)`). A class string
    // containing `data-[state=open]:text-...` or `hover:text-(--color-x)`
    // is still a plain class string and must be considered fixable. The
    // character set must stay identical to shouldExtractQuotedClassValue's —
    // the audit and fix paths gate on the same test by design.
    if (/[=><&|?*]/.test(stripBracketedSegments(content))) {
        return false;
    }

    const tokens = content.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return false;
    }

    const classLikeTokens = tokens.filter((token) => isLikelyFixUtility(token));
    if (classLikeTokens.length >= 2) {
        return true;
    }

    if (classLikeTokens.length === 1) {
        const token = classLikeTokens[0];
        return Boolean(
            (allowSingleTokenCanonical && (
                token.includes("[") ||
                token.includes("(--") ||
                getKnownCanonicalClass(token)
            )) ||
            (token.startsWith("!") && !token.endsWith("!")) ||
            /:[!]/.test(token),
        );
    }

    return false;
}

function transformFixableClassContent(content, canonicalizeCandidate, themeVarResolver = null) {
    const leading = (content.match(/^\s+/) ?? [""])[0];
    const trailing = (content.match(/\s+$/) ?? [""])[0];
    const middle = content.trim();
    if (!middle) {
        return content;
    }

    const tokens = middle.split(/\s+/).filter(Boolean);
    if (tokens.length < 1) {
        return content;
    }

    let changed = false;

    for (let i = 0; i < tokens.length; i += 1) {
        if (isLikelyFixUtility(tokens[i]) && !tokens[i].endsWith("!")) {
            const normalized = parseFixToken(tokens[i]).raw;
            if (normalized !== tokens[i]) {
                tokens[i] = normalized;
                changed = true;
            }
        }

        const knownCanonical = getKnownCanonicalClass(tokens[i]);
        if (knownCanonical && knownCanonical !== tokens[i]) {
            tokens[i] = knownCanonical;
            changed = true;
        }

        if (!isLikelyFixUtility(tokens[i])) {
            continue;
        }

        // Tailwind's canonicalizer is only relevant to bracket-bearing tokens.
        // Calling it for every ordinary class in a file merely because some
        // other class contains `[` is both expensive and inconsistent with the
        // audit path.
        if (canonicalizeCandidate && tokens[i].includes("[")) {
            const canonical = canonicalizeCandidate(tokens[i]);
            if (canonical && canonical !== tokens[i]) {
                tokens[i] = canonical;
                changed = true;
            }
        }

        if (themeVarResolver && tokenLooksLikeNamedThemeVarCandidate(tokens[i])) {
            const replacement = themeVarResolver(tokens[i]);
            if (replacement && replacement !== tokens[i]) {
                tokens[i] = replacement;
                changed = true;
            }
        }
    }

    let merged = true;
    while (merged) {
        merged = false;
        merged = mergeFixFamilyShorthand(tokens) || merged;
        merged = mergeFixWidthHeight(tokens) || merged;
        changed = changed || merged;
    }

    if (!changed) {
        return content;
    }

    return `${leading}${tokens.join(" ")}${trailing}`;
}

function applyFixesToText(text, canonicalizeCandidate, {
    allowSingleTokenCanonical = false,
    themeVarResolver = null,
    filePath = null,
} = {}) {
    let changed = false;
    let current = text;

    // The fixer rewrites exactly the spans the audit extracts — nothing else
    // in the file is ever touched. Spans can nest (a quoted string inside a
    // :class expression sits inside the attribute-value span), so each pass
    // applies edits right-to-left, preferring the innermost span on overlap;
    // the convergence loop then re-collects spans so a parent-level merge
    // exposed by a nested rewrite still lands. The cap only guards against a
    // hypothetical rewrite cycle — real inputs settle in one or two passes.
    for (let pass = 0; pass < 10; pass += 1) {
        const spans = extractClassLikeStrings(current, {
            allowSingleTokenCanonical,
            filePath,
        });
        let passChanged = false;
        let minAcceptedStart = Infinity;

        for (let i = spans.length - 1; i >= 0; i -= 1) {
            const span = spans[i];
            const end = span.index + span.value.length;
            if (end > minAcceptedStart) {
                continue;
            }
            if (!looksLikeFixableClassString(span.value, { allowSingleTokenCanonical })) {
                continue;
            }

            const next = transformFixableClassContent(span.value, canonicalizeCandidate, themeVarResolver);
            if (next === span.value) {
                continue;
            }

            current = current.slice(0, span.index) + next + current.slice(end);
            minAcceptedStart = span.index;
            passChanged = true;
        }

        if (!passChanged) {
            break;
        }
        changed = true;
    }

    return { changed, transformed: current };
}

function collectBracketFixCandidates(sourceText, allowSingleTokenCanonical, filePath) {
    const candidates = new Set();
    for (const span of extractClassLikeStrings(sourceText, {
        allowSingleTokenCanonical,
        filePath,
    })) {
        for (const raw of span.value.trim().split(/\s+/).filter(Boolean)) {
            if (raw.includes("[") && isLikelyFixUtility(raw)) {
                candidates.add(raw);
            }
        }
    }
    return candidates;
}

async function applyFixes(filePaths, {
    fixAll = false,
    suggestNamedThemeVars = false,
    themeCssPath = null,
    dryRun = false,
} = {}) {
    let changedFiles = 0;
    // Per-file failures are collected instead of thrown so one bad file can never
    // abort the batch and silently leave every later file unprocessed.
    const failures = [];
    const skipped = [];
    const liveCanonicalizationCandidates = new Set();
    let sharedCanonicalizer = null;

    // Resolve the theme CSS once up front so misconfiguration surfaces as a
    // single, loud error rather than a silent per-file no-op. The resolver is
    // engaged whenever the user supplied --theme-css OR explicitly opted into
    // suggestions; the safety gate during fix mode is the per-token CSS
    // equivalence check, not the flag, so we don't require the explicit
    // suggestion flag at fix time.
    let sharedThemeVarResolver = null;
    if (suggestNamedThemeVars || themeCssPath) {
        sharedThemeVarResolver = await getThemeVarResolver({ themeCssPath }).catch((error) => {
            console.error(error?.message || String(error));
            return null;
        });
    }

    for (const filePath of filePaths) {
        if (!fixAll && !filePath.endsWith(".vue")) {
            continue;
        }

        let originalStats;
        try {
            originalStats = await fs.lstat(filePath);
            if (originalStats.isSymbolicLink()) {
                skipped.push({ filePath, reason: "symbolic-link targets are not rewritten" });
                continue;
            }
            if (!originalStats.isFile()) {
                skipped.push({ filePath, reason: "target is not a regular file" });
                continue;
            }
            if (originalStats.size > MAX_SCANNED_FILE_BYTES) {
                skipped.push({ filePath, reason: `exceeds ${MAX_SCANNED_FILE_BYTES}-byte scan limit (${originalStats.size} bytes)` });
                continue;
            }
        } catch (error) {
            failures.push({ filePath, stage: "read", error });
            continue;
        }

        let sourceText;
        try {
            sourceText = await fs.readFile(filePath, "utf8");
        } catch (error) {
            failures.push({ filePath, stage: "read", error });
            continue;
        }

        // Isolate transform + write per file. A transform edge case, or a write
        // error such as EBUSY/EPERM (an editor or antivirus holding the file open
        // on Windows) or ENOSPC, must skip this one file and continue — not stop
        // the whole run. The write itself stays atomic (temp file + rename).
        try {
            // Test-only hook (mirrors NORMWIND_DISABLE_CANONICAL_SNAPSHOT) that
            // forces a transform throw for one named file, so the fault-isolation
            // contract can be exercised deterministically without crafting input
            // that happens to break the real parser.
            if (process.env.NORMWIND_TEST_FORCE_TRANSFORM_THROW === path.basename(filePath)) {
                throw new Error("normwinds: forced transform throw (NORMWIND_TEST_FORCE_TRANSFORM_THROW)");
            }

            const allowSingleTokenCanonical = filePath.endsWith(".vue");
            const bracketCandidates = collectBracketFixCandidates(
                sourceText,
                allowSingleTokenCanonical,
                filePath,
            );
            let hasCanonicalCacheMiss = false;
            for (const candidate of bracketCandidates) {
                if (CANONICAL_MEMO.has(candidate)) {
                    continue;
                }
                hasCanonicalCacheMiss = true;
                liveCanonicalizationCandidates.add(candidate);
            }
            if (liveCanonicalizationCandidates.size > MAX_LIVE_CANONICALIZATION_CANDIDATES) {
                throw new Error(
                    `normwinds: refusing to live-canonicalize more than ${MAX_LIVE_CANONICALIZATION_CANDIDATES} unique cache misses during fixes`,
                );
            }
            if (hasCanonicalCacheMiss && !sharedCanonicalizer) {
                sharedCanonicalizer = await getCanonicalizeCandidate();
            }
            const canonicalizeCandidate = bracketCandidates.size > 0
                ? (sharedCanonicalizer ?? lookupCanonicalFromMemo)
                : null;
            const themeVarResolver = sharedThemeVarResolver && /\(--|\[var\(--/.test(sourceText)
                ? sharedThemeVarResolver
                : null;
            const { changed, transformed } = applyFixesToText(sourceText, canonicalizeCandidate, {
                allowSingleTokenCanonical,
                themeVarResolver,
                filePath,
            });
            if (!changed) {
                continue;
            }

            if (dryRun) {
                // Keep --json stdout machine-parseable. Human progress belongs
                // on stderr in both text and JSON modes.
                console.error(`normwinds: [dry-run] would rewrite ${filePath}`);
                changedFiles += 1;
                continue;
            }

            // Write-then-rename so a crash or Ctrl-C mid-write can never leave
            // the user's source file truncated — the original stays intact until
            // the replacement is fully on disk. rename() is atomic on the same
            // volume, which the sibling temp path guarantees.
            const tmpPath = `${filePath}.normwinds-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
            try {
                await fs.writeFile(tmpPath, transformed, {
                    encoding: "utf8",
                    flag: "wx",
                    mode: originalStats.mode,
                });
                if (process.platform !== "win32") {
                    await fs.chmod(tmpPath, originalStats.mode);
                }
                if (process.env.NORMWIND_TEST_FORCE_WRITE_FAIL === path.basename(filePath)) {
                    const forced = new Error("normwinds: forced write failure (NORMWIND_TEST_FORCE_WRITE_FAIL)");
                    forced.code = "EPERM";
                    throw forced;
                }
                if (process.env.NORMWIND_TEST_MUTATE_BEFORE_RENAME === path.basename(filePath)) {
                    await fs.appendFile(filePath, "\n// simulated concurrent editor save\n", "utf8");
                }

                // Refuse to replace a file that changed after we read it. This
                // closes the common editor-save race where an atomic rename
                // would otherwise preserve a valid file while still discarding
                // newer user content.
                const latestSource = await fs.readFile(filePath, "utf8");
                if (latestSource !== sourceText) {
                    const conflict = new Error("file changed while fixes were being prepared");
                    conflict.code = "ESTALE";
                    throw conflict;
                }
                await fs.rename(tmpPath, filePath);
            } catch (error) {
                await fs.rm(tmpPath, { force: true }).catch(() => {});
                throw error;
            }
            changedFiles += 1;
        } catch (error) {
            failures.push({ filePath, stage: "fix", error });
        }
    }

    if (failures.length > 0 || skipped.length > 0) {
        console.error(
            `\nnormwinds: fix summary — ${changedFiles} ${dryRun ? "would-fix" : "fixed"}, ${skipped.length} skipped, ${failures.length} failed`,
        );
        for (const { filePath, reason } of skipped) {
            console.error(`  - ${filePath} [skipped]: ${reason}`);
        }
        for (const { filePath, stage, error } of failures) {
            console.error(`  - ${filePath} [failed:${stage}]: ${error?.message || String(error)}`);
        }
    }

    return { changedFiles, skipped: skipped.length, failed: failures.length };
}

function emitSuggestion(found, source, line, column, sources, target) {
    if (!sources.length) {
        return;
    }

    const classnames = sources.map((item) => item.raw).join(", ");
    maybePushFinding(found, {
        filePath: source,
        line,
        column,
        message: `Classnames '${classnames}' could be replaced by the '${target}' shorthand!`,
    });
}

function detectComplexEquivalences(groupedTokens, filePath, line, column, found) {
    for (const tokens of groupedTokens.values()) {
        const utilities = new Set(tokens.map((token) => token.utility));
        const byUtility = new Map(tokens.map((token) => [token.utility, token]));

        if (
            utilities.has("overflow-hidden") &&
            utilities.has("text-ellipsis") &&
            utilities.has("whitespace-nowrap") &&
            !utilities.has("truncate")
        ) {
            const target = formatClass(tokens[0].variants, tokens[0].important, "truncate");
            emitSuggestion(
                found,
                filePath,
                line,
                column,
                [
                    byUtility.get("overflow-hidden"),
                    byUtility.get("text-ellipsis"),
                    byUtility.get("whitespace-nowrap"),
                ].filter(Boolean),
                target,
            );
        }

        // Check every distinct width value rather than only the first w-/h-
        // tokens. The fixer already searches all pairs, so stopping at the first
        // conflicting width made an audit-clean file still change under
        // --fixall (for example: `w-4 w-6 h-6`).
        const heightsByValue = new Map();
        for (const token of tokens) {
            if (token.utility.startsWith("h-") && !heightsByValue.has(token.utility.slice(2))) {
                heightsByValue.set(token.utility.slice(2), token);
            }
        }
        const emittedSizeValues = new Set();
        for (const widthToken of tokens) {
            if (!widthToken.utility.startsWith("w-")) {
                continue;
            }
            const widthValue = widthToken.utility.slice(2);
            const heightToken = heightsByValue.get(widthValue);
            const sizeUtility = `size-${widthValue}`;
            if (heightToken && !utilities.has(sizeUtility) && !emittedSizeValues.has(widthValue)) {
                emittedSizeValues.add(widthValue);
                emitSuggestion(
                    found,
                    filePath,
                    line,
                    column,
                    [widthToken, heightToken],
                    formatClass(widthToken.variants, widthToken.important, sizeUtility),
                );
            }
        }

        for (const option of COMPLEX_EQUIVALENCES.placeContentOptions) {
            const content = byUtility.get(`content-${option}`);
            const justify = byUtility.get(`justify-${option}`);
            const targetUtility = `place-content-${option}`;
            if (content && justify && !utilities.has(targetUtility)) {
                emitSuggestion(
                    found,
                    filePath,
                    line,
                    column,
                    [content, justify],
                    formatClass(content.variants, content.important, targetUtility),
                );
            }
        }

        for (const option of COMPLEX_EQUIVALENCES.placeItemsOptions) {
            const items = byUtility.get(`items-${option}`);
            const justifyItems = byUtility.get(`justify-items-${option}`);
            const targetUtility = `place-items-${option}`;
            if (items && justifyItems && !utilities.has(targetUtility)) {
                emitSuggestion(
                    found,
                    filePath,
                    line,
                    column,
                    [items, justifyItems],
                    formatClass(items.variants, items.important, targetUtility),
                );
            }
        }

        for (const option of COMPLEX_EQUIVALENCES.placeSelfOptions) {
            const self = byUtility.get(`self-${option}`);
            const justifySelf = byUtility.get(`justify-self-${option}`);
            const targetUtility = `place-self-${option}`;
            if (self && justifySelf && !utilities.has(targetUtility)) {
                emitSuggestion(
                    found,
                    filePath,
                    line,
                    column,
                    [self, justifySelf],
                    formatClass(self.variants, self.important, targetUtility),
                );
            }
        }
    }
}

function detectFamilyShorthand(groupedTokens, filePath, line, column, found) {
    const { bodyIndex } = getShorthandFamilies();

    for (const tokens of groupedTokens.values()) {
        const familyClusters = new Map();

        for (const token of tokens) {
            for (const candidateBody of getUtilityBodyCandidates(token.utility)) {
                const matches = bodyIndex.get(candidateBody);
                if (!matches) {
                    continue;
                }

                const matched = matchUtilityToBody(token.utility, candidateBody);
                if (!matched) {
                    continue;
                }

                for (const { family, shorthand } of matches) {
                    if (!familyClusters.has(family)) {
                        familyClusters.set(family, new Map());
                    }

                    const clusters = familyClusters.get(family);
                    const clusterKey = `${matched.negative}|${matched.value}`;
                    if (!clusters.has(clusterKey)) {
                        clusters.set(clusterKey, new Map());
                    }

                    const shorthandMap = clusters.get(clusterKey);
                    if (!shorthandMap.has(shorthand)) {
                        shorthandMap.set(shorthand, []);
                    }

                    shorthandMap.get(shorthand).push(token);
                }
            }
        }

        for (const [family, clusters] of familyClusters.entries()) {
            for (const [clusterKey, shorthandMap] of clusters.entries()) {
                const [negative, value] = clusterKey.split("|");
                const get = (short) => shorthandMap.get(short)?.[0] ?? null;
                const has = (short) => Boolean(get(short));

                const buildTarget = (short) => {
                    const body = family.shorthandToBody.get(short);
                    if (!body) {
                        return null;
                    }

                    const utility = `${negative}${body}${value ? `-${value}` : ""}`;
                    return formatClass(tokens[0].variants, tokens[0].important, utility);
                };

                if (has("x") && has("y") && !has("all")) {
                    const target = buildTarget("all");
                    if (target) {
                        emitSuggestion(found, filePath, line, column, [get("x"), get("y")], target);
                    }
                }

                if (has("l") && has("r") && !has("x")) {
                    const target = buildTarget("x");
                    if (target) {
                        emitSuggestion(found, filePath, line, column, [get("l"), get("r")], target);
                    }
                }

                if (has("t") && has("b") && !has("y")) {
                    const target = buildTarget("y");
                    if (target) {
                        emitSuggestion(found, filePath, line, column, [get("t"), get("b")], target);
                    }
                }

                if (family.supportsCorners) {
                    if (has("tl") && has("tr") && !has("t")) {
                        const target = buildTarget("t");
                        if (target) {
                            emitSuggestion(found, filePath, line, column, [get("tl"), get("tr")], target);
                        }
                    }

                    if (has("tr") && has("br") && !has("r")) {
                        const target = buildTarget("r");
                        if (target) {
                            emitSuggestion(found, filePath, line, column, [get("tr"), get("br")], target);
                        }
                    }

                    if (has("bl") && has("br") && !has("b")) {
                        const target = buildTarget("b");
                        if (target) {
                            emitSuggestion(found, filePath, line, column, [get("bl"), get("br")], target);
                        }
                    }

                    if (has("tl") && has("bl") && !has("l")) {
                        const target = buildTarget("l");
                        if (target) {
                            emitSuggestion(found, filePath, line, column, [get("tl"), get("bl")], target);
                        }
                    }
                }

                if (!has("all") && has("t") && has("r") && has("b") && has("l")) {
                    const target = buildTarget("all");
                    if (target) {
                        emitSuggestion(
                            found,
                            filePath,
                            line,
                            column,
                            [get("t"), get("r"), get("b"), get("l")],
                            target,
                        );
                    }
                }
            }
        }
    }
}

function getUtilityBodyCandidates(utility) {
    if (UTILITY_BODY_CANDIDATES_CACHE.has(utility)) {
        return UTILITY_BODY_CANDIDATES_CACHE.get(utility);
    }

    const normalized = utility.startsWith("-") ? utility.slice(1) : utility;
    const candidates = [];
    const seen = new Set();

    const pushCandidate = (value) => {
        if (value && !seen.has(value)) {
            seen.add(value);
            candidates.push(value);
        }
    };

    pushCandidate(normalized);

    for (let index = normalized.indexOf("-"); index >= 0; index = normalized.indexOf("-", index + 1)) {
        pushCandidate(normalized.slice(0, index));
    }

    UTILITY_BODY_CANDIDATES_CACHE.set(utility, candidates);
    return candidates;
}

function buildLineStarts(text) {
    const starts = [0];
    let idx = text.indexOf("\n");
    while (idx !== -1) {
        starts.push(idx + 1);
        idx = text.indexOf("\n", idx + 1);
    }
    return starts;
}

function indexToLineCol(lineStarts, index) {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineStarts[mid] <= index) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const lineIndex = Math.max(0, high);
    return {
        line: lineIndex + 1,
        column: index - lineStarts[lineIndex] + 1,
    };
}

const QUOTE_VALUE_SHAPE = /\b(?:[a-z]+:)*!?-?[a-z][a-z0-9-]*(?:-[^\s]+)*!?\b/i;

function shouldExtractQuotedClassValue(value, { allowSingleTokenCanonical = false } = {}) {
    const singleToken = !value.includes(" ");
    if (
        singleToken &&
        !(
            (allowSingleTokenCanonical && (
                value.includes("[") ||
                value.includes("(--") ||
                getKnownCanonicalClass(value)
            )) ||
            value.startsWith("!") ||
            value.includes(":!")
        )
    ) {
        return false;
    }

    if (!value.includes("-") && !value.includes("!")) {
        return false;
    }

    // Operator characters only disqualify when they appear OUTSIDE Tailwind's
    // arbitrary-value brackets/parens — `data-[state=open]:x` is a plain
    // class string. This mirrors looksLikeFixableClassString exactly: the
    // audit and fix paths must agree on what counts as a class string, or
    // "audit clean" stops implying "fix is a no-op".
    if (/[=><&|?*]/.test(stripBracketedSegments(value))) {
        return false;
    }

    return QUOTE_VALUE_SHAPE.test(value);
}

// Split a template-literal body into its static text chunks around `${...}`
// interpolations, so an operator inside an interpolation cannot disqualify
// (or expose to rewriting) the static class tokens around it. Chunks that
// butt directly against an interpolation get their partial edge token
// trimmed — `h-${size}` must never surface a bare `h-` token.
function splitTemplateStaticChunks(content) {
    const chunks = [];
    let chunkStart = 0;
    let i = 0;

    const pushChunk = (start, end, openEdge, closeEdge) => {
        let s = start;
        let e = end;
        if (openEdge && s < e && !/\s/.test(content[s])) {
            const ws = content.slice(s, e).search(/\s/);
            if (ws === -1) {
                return;
            }
            s += ws;
        }
        if (closeEdge && s < e && !/\s/.test(content[e - 1])) {
            const trimmed = content.slice(s, e).replace(/\S+$/, "");
            e = s + trimmed.length;
        }
        if (s < e) {
            chunks.push({ text: content.slice(s, e), offset: s });
        }
    };

    while (i < content.length) {
        if (content[i] === "\\") {
            i += 2;
            continue;
        }
        if (content[i] === "$" && content[i + 1] === "{") {
            pushChunk(chunkStart, i, chunkStart > 0, true);
            // Skip the interpolation body (depth-aware, quote-aware).
            let depth = 0;
            let quote = null;
            let j = i + 1;
            for (; j < content.length; j += 1) {
                const ch = content[j];
                if (quote) {
                    if (ch === "\\") {
                        j += 1;
                    } else if (ch === quote) {
                        quote = null;
                    }
                    continue;
                }
                if (ch === '"' || ch === "'" || ch === "`") {
                    quote = ch;
                } else if (ch === "{") {
                    depth += 1;
                } else if (ch === "}") {
                    depth -= 1;
                    if (depth === 0) {
                        break;
                    }
                }
            }
            i = j + 1;
            chunkStart = i;
            continue;
        }
        i += 1;
    }

    pushChunk(chunkStart, content.length, chunkStart > 0, false);
    return chunks;
}

const NESTED_QUOTE_REGEXES = {
    '"': /"((?:\\.|[^"\\])*)"/g,
    "'": /'((?:\\.|[^'\\])*)'/g,
    "`": /`((?:\\.|[^`\\])*)`/g,
};

function extractNestedQuotedClassStrings(value, baseIndex, options, quoteKinds = ["'", "`"]) {
    const results = [];

    for (const kind of quoteKinds) {
        const quoteRegex = NESTED_QUOTE_REGEXES[kind];
        quoteRegex.lastIndex = 0;
        let match;
        while ((match = quoteRegex.exec(value)) !== null) {
            const quotedValue = match[1];
            const quotedStart = baseIndex + match.index + 1;

            if (kind === "`" && quotedValue.includes("${")) {
                for (const chunk of splitTemplateStaticChunks(quotedValue)) {
                    if (shouldExtractQuotedClassValue(chunk.text, options)) {
                        results.push({
                            value: chunk.text,
                            index: quotedStart + chunk.offset,
                        });
                    }
                }
                continue;
            }

            if (!shouldExtractQuotedClassValue(quotedValue, options)) {
                continue;
            }

            results.push({
                value: quotedValue,
                index: quotedStart,
            });
        }
    }

    return results;
}

// ---------------------------------------------------------------------------
// Class-string extraction, shared by the audit and fix paths.
//
// Extraction is anchored to class-bearing attributes: `class`, `className`,
// `:class`, and `v-bind:class` (quoted or JSX-brace values), plus quoted
// strings nested inside those values (ternaries, object bindings). Blanket
// scanning of every quoted string in the file — the pre-3.4 behavior — is
// gone: it rewrote unrelated code whose strings merely looked like utility
// lists (SQL fragments, title attributes, debug labels).
//
// Both paths sharing one extractor is a correctness contract: if the audit
// reports clean, the fixer must be a no-op on the same file.
// ---------------------------------------------------------------------------

// The lookbehind refuses a preceding [\w-] so attribute names that merely end
// in "class" (data-class, my-class, aria-class) never match.
const CLASS_ATTR_VALUE_REGEX = /(?<![\w-])(?:v-bind:class|className|:class|class)\s*=\s*(["'])([\s\S]*?)\1/g;
const CLASS_ATTR_BRACE_REGEX = /(?<![\w-])(?:className|class)\s*=\s*\{/g;
// Object-property form: `{ class: '...' }` / `{ className: "..." }` as used
// by createElement/hyperscript/render-function calls. Syntax analysis below
// limits these matches to props objects passed to known render functions.
const CLASS_OBJECT_KEY_REGEX = /(?<![\w-])(?:className|class)\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const CLASS_ATTRIBUTE_NAMES = new Set(["class", "className", ":class", "v-bind:class"]);
const RENDER_FUNCTION_NAMES = new Set([
    "h",
    "createElement",
    "createVNode",
    "createElementVNode",
    "createBlock",
    "createElementBlock",
    "cloneVNode",
    "jsx",
    "jsxs",
    "jsxDEV",
    "_jsx",
    "_jsxs",
    "_jsxDEV",
]);
function getBabelParser() {
    return bundledBabelParser;
}

function unwrapExpression(node) {
    let current = node;
    const wrapperTypes = new Set([
        "ChainExpression",
        "ParenthesizedExpression",
        "TSAsExpression",
        "TSInstantiationExpression",
        "TSNonNullExpression",
        "TSSatisfiesExpression",
        "TSTypeAssertion",
        "TypeCastExpression",
    ]);
    while (current && wrapperTypes.has(current.type)) {
        current = current.expression;
    }
    return current;
}

function getCalledFunctionName(callee) {
    const unwrapped = unwrapExpression(callee);
    if (unwrapped?.type === "Identifier") {
        return unwrapped.name;
    }
    if (unwrapped?.type === "MemberExpression" || unwrapped?.type === "OptionalMemberExpression") {
        if (!unwrapped.computed && unwrapped.property?.type === "Identifier") {
            return unwrapped.property.name;
        }
        if (unwrapped.computed && unwrapped.property?.type === "StringLiteral") {
            return unwrapped.property.value;
        }
    }
    return null;
}

function getObjectPropertyName(property) {
    if (property?.type !== "ObjectProperty" || property.computed) {
        return null;
    }
    if (property.key?.type === "Identifier") {
        return property.key.name;
    }
    if (property.key?.type === "StringLiteral") {
        return property.key.value;
    }
    return null;
}

function analyzeBabelAst(ast, offset = 0) {
    const allowedAttributeStarts = new Set();
    const allowedObjectPropertyStarts = new Set();
    const renderFunctionNames = new Set(RENDER_FUNCTION_NAMES);
    const aliasPairs = [];
    const callNodes = [];
    const stack = [ast];

    while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== "object") {
            continue;
        }

        if (node.type === "JSXAttribute") {
            const name = node.name?.type === "JSXIdentifier" ? node.name.name : null;
            if ((name === "class" || name === "className") && Number.isInteger(node.start)) {
                allowedAttributeStarts.add(offset + node.start);
            }
        } else if (node.type === "ImportSpecifier") {
            const imported = node.imported?.name ?? node.imported?.value;
            const local = node.local?.name;
            if (typeof imported === "string" && typeof local === "string") {
                aliasPairs.push([local, imported]);
            }
        } else if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
            const sourceName = getCalledFunctionName(node.init);
            if (sourceName) {
                aliasPairs.push([node.id.name, sourceName]);
            }
        } else if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
            callNodes.push(node);
        }

        for (const [key, value] of Object.entries(node)) {
            if (
                key === "loc"
                || key === "errors"
                || key === "comments"
                || key === "tokens"
                || key === "extra"
            ) {
                continue;
            }
            if (Array.isArray(value)) {
                for (let i = value.length - 1; i >= 0; i -= 1) {
                    if (value[i] && typeof value[i] === "object") {
                        stack.push(value[i]);
                    }
                }
            } else if (value && typeof value === "object") {
                stack.push(value);
            }
        }
    }

    // Resolve imported/local aliases after traversal so source order and the
    // iterative stack order cannot affect whether a render call is recognized.
    let addedAlias = true;
    while (addedAlias) {
        addedAlias = false;
        for (const [local, source] of aliasPairs) {
            if (renderFunctionNames.has(source) && !renderFunctionNames.has(local)) {
                renderFunctionNames.add(local);
                addedAlias = true;
            }
        }
    }

    for (const call of callNodes) {
        const calleeName = getCalledFunctionName(call.callee);
        if (!calleeName || !renderFunctionNames.has(calleeName)) {
            continue;
        }

        // In React/Vue/Preact-style render APIs, the first argument is the
        // element/component and subsequent direct object arguments are props.
        for (const argument of call.arguments.slice(1)) {
            const props = unwrapExpression(argument);
            if (props?.type !== "ObjectExpression") {
                continue;
            }
            for (const property of props.properties) {
                const propertyName = getObjectPropertyName(property);
                if (
                    (propertyName === "class" || propertyName === "className")
                    && Number.isInteger(property.key?.start)
                ) {
                    allowedObjectPropertyStarts.add(offset + property.key.start);
                }
            }
        }
    }

    return { allowedAttributeStarts, allowedObjectPropertyStarts };
}

function parserPluginVariants({ typescript, jsx }) {
    const syntaxVariants = typescript
        ? [["typescript"]]
        : [[], ["flow"]];
    const decoratorVariants = [
        ["decorators-legacy"],
        [["decorators", { decoratorsBeforeExport: true }]],
    ];
    const variants = [];

    for (const syntaxPlugins of syntaxVariants) {
        for (const decoratorPlugins of decoratorVariants) {
            variants.push([
                ...syntaxPlugins,
                ...(jsx ? ["jsx"] : []),
                ...decoratorPlugins,
                "explicitResourceManagement",
                "importAttributes",
            ]);
        }
    }
    return variants;
}

function parseAndAnalyzeJavaScript(
    sourceText,
    filePath,
    { typescript = false, jsx = false, offset = 0 } = {},
) {
    const { parse } = getBabelParser();
    let lastError = null;

    for (const plugins of parserPluginVariants({ typescript, jsx })) {
        try {
            const ast = parse(sourceText, {
                sourceType: "unambiguous",
                sourceFilename: filePath,
                plugins,
                errorRecovery: true,
                attachComment: false,
                allowAwaitOutsideFunction: true,
                allowImportExportEverywhere: true,
                allowNewTargetOutsideFunction: true,
                allowReturnOutsideFunction: true,
                allowSuperOutsideMethod: true,
                allowUndeclaredExports: true,
            });
            if (ast.errors?.length > 0) {
                lastError = ast.errors[0];
                continue;
            }
            return analyzeBabelAst(ast, offset);
        } catch (error) {
            lastError = error;
        }
    }

    const detail = lastError?.message ?? "unknown parser error";
    throw new Error(`could not safely parse ${filePath}: ${detail}`);
}

function findMarkupTagEnd(sourceText, openIndex) {
    let quote = null;
    for (let i = openIndex + 1; i < sourceText.length; i += 1) {
        const ch = sourceText[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === ">") {
            return i;
        }
    }
    return -1;
}

function parseMarkupTag(sourceText, openIndex) {
    const end = findMarkupTagEnd(sourceText, openIndex);
    if (end === -1) {
        return null;
    }

    let cursor = openIndex + 1;
    while (cursor < end && /\s/.test(sourceText[cursor])) {
        cursor += 1;
    }
    const closing = sourceText[cursor] === "/";
    if (closing) {
        cursor += 1;
        while (cursor < end && /\s/.test(sourceText[cursor])) {
            cursor += 1;
        }
    }
    const nameStart = cursor;
    while (cursor < end && !/[\s/>]/.test(sourceText[cursor])) {
        cursor += 1;
    }
    const name = sourceText.slice(nameStart, cursor);
    if (!name || name.startsWith("!") || name.startsWith("?")) {
        return { end, closing, name: "", selfClosing: false, attributes: [] };
    }
    if (closing) {
        return {
            end,
            closing: true,
            name,
            selfClosing: false,
            attributes: [],
        };
    }

    const attributes = [];
    while (cursor < end) {
        while (cursor < end && /\s/.test(sourceText[cursor])) {
            cursor += 1;
        }
        if (cursor >= end || sourceText[cursor] === "/") {
            break;
        }

        const start = cursor;
        while (cursor < end && !/[\s=/>]/.test(sourceText[cursor])) {
            cursor += 1;
        }
        const attributeName = sourceText.slice(start, cursor);
        while (cursor < end && /\s/.test(sourceText[cursor])) {
            cursor += 1;
        }

        let value = null;
        if (sourceText[cursor] === "=") {
            cursor += 1;
            while (cursor < end && /\s/.test(sourceText[cursor])) {
                cursor += 1;
            }
            const quote = sourceText[cursor];
            if (quote === '"' || quote === "'") {
                const valueStart = cursor + 1;
                cursor = valueStart;
                while (cursor < end && sourceText[cursor] !== quote) {
                    cursor += 1;
                }
                value = sourceText.slice(valueStart, cursor);
                cursor += cursor < end ? 1 : 0;
            } else if (sourceText[cursor] === "{") {
                const braceEnd = findBalancedBraceEnd(sourceText, cursor);
                cursor = braceEnd !== -1 && braceEnd <= end ? braceEnd + 1 : end;
            } else {
                const valueStart = cursor;
                while (cursor < end && !/[\s>]/.test(sourceText[cursor])) {
                    cursor += 1;
                }
                value = sourceText.slice(valueStart, cursor);
            }
        }
        if (attributeName) {
            attributes.push({ name: attributeName, start, value });
        } else {
            cursor += 1;
        }
    }

    let slashCursor = end - 1;
    while (slashCursor > openIndex && /\s/.test(sourceText[slashCursor])) {
        slashCursor -= 1;
    }
    return {
        end,
        closing: false,
        name,
        selfClosing: sourceText[slashCursor] === "/",
        attributes,
    };
}

function findRawElementClose(sourceText, tagName, fromIndex) {
    const closeRegex = new RegExp(`</${tagName}\\s*>`, "gi");
    closeRegex.lastIndex = fromIndex;
    const match = closeRegex.exec(sourceText);
    if (!match) {
        return null;
    }
    return { start: match.index, end: match.index + match[0].length };
}

function analyzeVueStructure(sourceText) {
    const allowedAttributeStarts = new Set();
    const scriptBlocks = [];
    let templateDepth = 0;
    let cursor = 0;

    while (cursor < sourceText.length) {
        const nextTag = sourceText.indexOf("<", cursor);
        const nextInterpolation = templateDepth > 0
            ? sourceText.indexOf("{{", cursor)
            : -1;

        if (
            nextInterpolation !== -1
            && (nextTag === -1 || nextInterpolation < nextTag)
        ) {
            const interpolationEnd = sourceText.indexOf("}}", nextInterpolation + 2);
            cursor = interpolationEnd === -1 ? sourceText.length : interpolationEnd + 2;
            continue;
        }
        if (nextTag === -1) {
            break;
        }
        if (sourceText.startsWith("<!--", nextTag)) {
            const commentEnd = sourceText.indexOf("-->", nextTag + 4);
            cursor = commentEnd === -1 ? sourceText.length : commentEnd + 3;
            continue;
        }

        const tag = parseMarkupTag(sourceText, nextTag);
        if (!tag) {
            break;
        }
        const lowerName = tag.name.toLowerCase();

        if (tag.closing) {
            if (lowerName === "template" && templateDepth > 0) {
                templateDepth -= 1;
            }
            cursor = tag.end + 1;
            continue;
        }

        if (templateDepth > 0 && lowerName !== "template") {
            for (const attribute of tag.attributes) {
                if (CLASS_ATTRIBUTE_NAMES.has(attribute.name)) {
                    allowedAttributeStarts.add(attribute.start);
                }
            }
        }

        if (lowerName === "template" && !tag.selfClosing) {
            templateDepth += 1;
            cursor = tag.end + 1;
            continue;
        }

        if (templateDepth === 0 && (lowerName === "script" || lowerName === "style")) {
            const close = findRawElementClose(sourceText, lowerName, tag.end + 1);
            if (!close) {
                cursor = sourceText.length;
                continue;
            }
            if (lowerName === "script") {
                const lang = tag.attributes
                    .find((attribute) => attribute.name.toLowerCase() === "lang")
                    ?.value
                    ?.toLowerCase() ?? "js";
                scriptBlocks.push({
                    source: sourceText.slice(tag.end + 1, close.start),
                    offset: tag.end + 1,
                    lang,
                });
            }
            cursor = close.end;
            continue;
        }

        // Unknown top-level SFC custom blocks are not Vue templates. Skip
        // their raw contents so embedded markup/data cannot be mistaken for
        // renderable class attributes.
        if (templateDepth === 0 && lowerName && !tag.selfClosing) {
            const close = findRawElementClose(sourceText, lowerName, tag.end + 1);
            cursor = close ? close.end : tag.end + 1;
            continue;
        }

        cursor = tag.end + 1;
    }

    return { allowedAttributeStarts, scriptBlocks };
}

function mergeSyntaxAnalysis(target, source) {
    for (const start of source.allowedAttributeStarts) {
        target.allowedAttributeStarts.add(start);
    }
    for (const start of source.allowedObjectPropertyStarts) {
        target.allowedObjectPropertyStarts.add(start);
    }
}

function analyzeClassSyntax(sourceText, filePath) {
    const analysis = {
        allowedAttributeStarts: new Set(),
        allowedObjectPropertyStarts: new Set(),
    };
    const normalizedPath = String(filePath ?? "source.js").toLowerCase();
    const extension = path.extname(normalizedPath);

    if (extension === ".vue") {
        const vue = analyzeVueStructure(sourceText);
        for (const start of vue.allowedAttributeStarts) {
            analysis.allowedAttributeStarts.add(start);
        }
        for (const block of vue.scriptBlocks) {
            const isTypeScript = ["ts", "tsx", "mts", "cts"].includes(block.lang);
            const isJavaScript = ["js", "jsx", "mjs", "cjs", "babel"].includes(block.lang);
            if (!isTypeScript && !isJavaScript) {
                continue;
            }
            const scriptAnalysis = parseAndAnalyzeJavaScript(
                block.source,
                `${filePath ?? "source.vue"}?script=${block.lang}`,
                {
                    typescript: isTypeScript,
                    jsx: block.lang === "tsx" || block.lang === "jsx" || isJavaScript,
                    offset: block.offset,
                },
            );
            mergeSyntaxAnalysis(analysis, scriptAnalysis);
        }
        return analysis;
    }

    const isTypeScript = extension === ".ts" || extension === ".tsx";
    return parseAndAnalyzeJavaScript(sourceText, filePath ?? "source.js", {
        typescript: isTypeScript,
        jsx: extension === ".jsx" || extension === ".tsx" || !isTypeScript,
    });
}

// Find the index of the `}` matching the `{` at openIndex, respecting quoted
// strings inside the expression. Returns -1 when unbalanced.
function findBalancedBraceEnd(text, openIndex) {
    let depth = 0;
    let quote = null;
    for (let i = openIndex; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (ch === "\\") {
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "{") {
            depth += 1;
        } else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

function extractClassLikeStrings(
    sourceText,
    { allowSingleTokenCanonical = false, filePath = null } = {},
) {
    if (!sourceText.includes("class")) {
        return [];
    }
    const {
        allowedAttributeStarts,
        allowedObjectPropertyStarts,
    } = analyzeClassSyntax(sourceText, filePath);
    const results = [];
    const seen = new Set();
    const push = (value, index) => {
        const key = `${index}:${value.length}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        results.push({ value, index });
    };

    CLASS_ATTR_VALUE_REGEX.lastIndex = 0;
    let match;
    while ((match = CLASS_ATTR_VALUE_REGEX.exec(sourceText)) !== null) {
        if (!allowedAttributeStarts.has(match.index)) {
            continue;
        }
        const value = match[2];
        // The value sits immediately before the closing quote, so compute its
        // start positionally — indexOf would hit an earlier occurrence for
        // values like class="class".
        const startIndex = match.index + match[0].length - 1 - value.length;
        push(value, startIndex);

        const nestedKinds = match[1] === '"' ? ["'", "`"] : ['"', "`"];
        for (const nested of extractNestedQuotedClassStrings(
            value,
            startIndex,
            { allowSingleTokenCanonical },
            nestedKinds,
        )) {
            push(nested.value, nested.index);
        }
    }

    CLASS_ATTR_BRACE_REGEX.lastIndex = 0;
    while ((match = CLASS_ATTR_BRACE_REGEX.exec(sourceText)) !== null) {
        if (!allowedAttributeStarts.has(match.index)) {
            continue;
        }
        const openIndex = match.index + match[0].length - 1;
        const closeIndex = findBalancedBraceEnd(sourceText, openIndex);
        if (closeIndex === -1) {
            continue;
        }

        const body = sourceText.slice(openIndex + 1, closeIndex);
        for (const nested of extractNestedQuotedClassStrings(
            body,
            openIndex + 1,
            { allowSingleTokenCanonical },
            ['"', "'", "`"],
        )) {
            push(nested.value, nested.index);
        }
        CLASS_ATTR_BRACE_REGEX.lastIndex = closeIndex + 1;
    }

    CLASS_OBJECT_KEY_REGEX.lastIndex = 0;
    while ((match = CLASS_OBJECT_KEY_REGEX.exec(sourceText)) !== null) {
        if (!allowedObjectPropertyStarts.has(match.index)) {
            continue;
        }
        const value = match[2];
        const startIndex = match.index + match[0].length - 1 - value.length;

        if (match[1] === "`" && value.includes("${")) {
            for (const chunk of splitTemplateStaticChunks(value)) {
                if (shouldExtractQuotedClassValue(chunk.text, { allowSingleTokenCanonical })) {
                    push(chunk.text, startIndex + chunk.offset);
                }
            }
            continue;
        }

        if (shouldExtractQuotedClassValue(value, { allowSingleTokenCanonical })) {
            push(value, startIndex);
        }
    }

    results.sort((a, b) => a.index - b.index);
    return results;
}

function collectArbitraryValueTokens(snippetValue, snippetIndex, lineStarts) {
    const found = [];
    const arbitraryRegex = /(?:^|\s)((?:[a-z0-9-]+:)*!?[a-z][a-z0-9-]*-\[[^\]\s]+\]!?)(?=\s|$)/gi;
    let match;

    while ((match = arbitraryRegex.exec(snippetValue)) !== null) {
        const raw = match[1];
        const rawOffset = match.index + match[0].lastIndexOf(raw);
        const position = indexToLineCol(lineStarts, snippetIndex + rawOffset);

        found.push({
            raw,
            line: position.line,
            column: position.column,
        });
    }

    return found;
}

function hasGlobSyntax(value) {
    return /[*?[\]{}]/.test(value);
}

function validateActionPattern(pattern) {
    if (!ACTION_WORKSPACE_ROOT) {
        return;
    }
    const normalized = pattern.replace(/\\/g, "/");
    const segments = normalized.split("/");
    if (
        pattern.includes("\0")
        || path.isAbsolute(pattern)
        || path.win32.isAbsolute(pattern)
        || segments.includes("..")
    ) {
        throw new Error(`normwinds: Action patterns must stay inside the working directory: ${pattern}`);
    }
}

function hasAllowedExtension(filePath) {
    return /\.(?:vue|js|mjs|ts|jsx|tsx)$/i.test(filePath);
}

function normalizeRelativePath(filePath) {
    return path.relative(process.cwd(), path.resolve(process.cwd(), filePath)).replace(/\\/g, "/");
}

function isIgnoredRelativePath(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("../")) {
        return true;
    }

    if (IGNORED_EXACT_PATHS.has(normalized)) {
        return true;
    }

    if (IGNORED_ROOT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        return true;
    }

    const segments = normalized.split("/");
    return segments.some((segment) => IGNORED_SEGMENTS.has(segment));
}

async function listFilesWithRipgrep(patterns) {
    if (process.env.NORMWIND_DISABLE_RIPGREP === "1") {
        const error = new Error("ripgrep is disabled in GitHub Action mode");
        error.code = "ENOENT";
        throw error;
    }
    const args = ["--files", "--hidden"];
    for (const glob of RG_IGNORE_GLOBS) {
        args.push("-g", glob);
    }
    for (const pattern of patterns) {
        args.push("-g", pattern);
    }
    args.push(".");

    let stdout;
    try {
        ({ stdout } = await execFileAsync("rg", args, {
            cwd: process.cwd(),
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true,
        }));
    } catch (error) {
        // rg exit code 1 means "ran fine, nothing matched" — that is a valid
        // empty result, NOT a reason to fall back to walking the whole tree
        // (which would silently scan everything a typo'd pattern never asked
        // for). Only spawn failures / real errors propagate to the fallback.
        if (error?.code === 1) {
            return [];
        }
        throw error;
    }

    return stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((filePath) => path.resolve(process.cwd(), filePath));
}

// Minimal glob-to-RegExp conversion covering the syntax the CLI documents
// (`**`, `*`, `?`, `{a,b}`), so the no-ripgrep fallback honors the same
// patterns instead of returning every file in the tree.
function globPatternToRegExp(pattern) {
    const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    let out = "";
    for (let i = 0; i < normalized.length; i += 1) {
        const ch = normalized[i];
        if (ch === "*") {
            if (normalized[i + 1] === "*") {
                if (normalized[i + 2] === "/") {
                    out += "(?:[^/]+/)*";
                    i += 2;
                } else {
                    out += ".*";
                    i += 1;
                }
            } else {
                out += "[^/]*";
            }
        } else if (ch === "?") {
            out += "[^/]";
        } else if (ch === "{") {
            const close = normalized.indexOf("}", i);
            if (close === -1) {
                out += "\\{";
                continue;
            }
            const alts = normalized
                .slice(i + 1, close)
                .split(",")
                .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            out += `(?:${alts.join("|")})`;
            i = close;
        } else {
            out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
    }

    // Like ripgrep: a pattern containing "/" anchors at the tree root; a bare
    // pattern matches against the basename at any depth.
    return normalized.includes("/")
        ? new RegExp(`^${out}$`)
        : new RegExp(`(?:^|/)${out}$`);
}

// visitedRealPaths guards against symlink loops: a directory symlink cycle
// (A/link -> B, B/link -> A) would otherwise recurse forever, since a plain
// entry.isDirectory() check follows the link. Each directory is realpath'd
// and deduped before recursing so a loop is walked at most once.
async function walkDirectory(directoryPath, results, visitedRealPaths = new Set()) {
    if (ACTION_WORKSPACE_ROOT) {
        await resolveActionSafePath(directoryPath, "scan directory");
    }
    let entries;
    try {
        entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name);
        const relativePath = normalizeRelativePath(fullPath);
        if (isIgnoredRelativePath(relativePath)) {
            continue;
        }

        if (entry.isSymbolicLink()) {
            const targetStats = await fs.stat(fullPath).catch(() => null);
            if (!targetStats || !targetStats.isDirectory()) {
                continue;
            }
            if (ACTION_WORKSPACE_ROOT) {
                throw new Error(`normwinds: Action mode refuses directory symlinks: ${relativePath}`);
            }
        } else if (!entry.isDirectory()) {
            if (entry.isFile() && hasAllowedExtension(relativePath)) {
                results.push(path.resolve(fullPath));
            }
            continue;
        }

        const realPath = await fs.realpath(fullPath).catch(() => null);
        if (!realPath) {
            continue;
        }
        if (!ACTION_WORKSPACE_ROOT) {
            if (visitedRealPaths.has(realPath)) {
                continue;
            }
            visitedRealPaths.add(realPath);
        }
        await walkDirectory(fullPath, results, visitedRealPaths);
    }
}

async function listTargetFiles(patterns) {
    const explicitFiles = new Set();
    const directoryTargets = [];
    const globPatterns = [];

    const targetPatterns = patterns.length > 0 ? patterns : DEFAULT_PATTERNS;

    for (const pattern of targetPatterns) {
        validateActionPattern(pattern);
        if (hasGlobSyntax(pattern)) {
            globPatterns.push(pattern);
            continue;
        }

        const resolved = path.resolve(process.cwd(), pattern);
        let stats = null;
        let targetPath = resolved;
        let linkStats;
        try {
            linkStats = await fs.lstat(resolved);
        } catch {
            globPatterns.push(pattern);
            continue;
        }
        if (ACTION_WORKSPACE_ROOT && linkStats.isSymbolicLink()) {
            targetPath = await resolveActionSafePath(resolved, `target "${pattern}"`);
            stats = await fs.stat(targetPath);
            if (stats.isDirectory()) {
                throw new Error(`normwinds: Action mode refuses directory symlink target: ${pattern}`);
            }
        } else {
            stats = await fs.stat(resolved);
        }

        if (stats.isDirectory()) {
            directoryTargets.push(targetPath);
            continue;
        }

        if (stats.isFile()) {
            const relativePath = normalizeRelativePath(targetPath);
            if (!isIgnoredRelativePath(relativePath) && hasAllowedExtension(relativePath)) {
                explicitFiles.add(path.resolve(targetPath));
            }
        }
    }

    const discoveredFiles = new Set(explicitFiles);

    if (globPatterns.length > 0) {
        try {
            const files = await listFilesWithRipgrep(globPatterns);
            for (const filePath of files) {
                const relativePath = normalizeRelativePath(filePath);
                if (!isIgnoredRelativePath(relativePath) && hasAllowedExtension(relativePath)) {
                    discoveredFiles.add(path.resolve(filePath));
                }
            }
        } catch {
            // ripgrep unavailable: walk the tree and apply the globs manually
            // so the fallback discovers the same set rg would have.
            const globRegexes = globPatterns.map(globPatternToRegExp);
            const walkedFiles = [];
            await walkDirectory(process.cwd(), walkedFiles);
            for (const filePath of walkedFiles) {
                const relativePath = normalizeRelativePath(filePath);
                if (globRegexes.some((regex) => regex.test(relativePath))) {
                    discoveredFiles.add(path.resolve(filePath));
                }
            }
        }
    }

    // Positional targets are a union. A directory must still contribute all of
    // its lintable files when a separate glob is supplied in the same command.
    if (directoryTargets.length > 0) {
        for (const directoryPath of directoryTargets) {
            const files = [];
            await walkDirectory(directoryPath, files);
            for (const filePath of files) {
                discoveredFiles.add(path.resolve(filePath));
            }
        }
    }

    if (globPatterns.length === 0 && directoryTargets.length === 0 && explicitFiles.size === 0) {
        const files = await listFilesWithRipgrep(DEFAULT_PATTERNS).catch(async () => {
            const walkedFiles = [];
            await walkDirectory(process.cwd(), walkedFiles);
            return walkedFiles;
        });

        for (const filePath of files) {
            const relativePath = normalizeRelativePath(filePath);
            if (!isIgnoredRelativePath(relativePath) && hasAllowedExtension(relativePath)) {
                discoveredFiles.add(path.resolve(filePath));
            }
        }
    }

    const sortedFiles = [...discoveredFiles].sort((a, b) => a.localeCompare(b));
    if (!ACTION_WORKSPACE_ROOT) {
        return sortedFiles;
    }
    if (sortedFiles.length > ACTION_MAX_FILES) {
        throw new Error(`normwinds: Action scan exceeds the ${ACTION_MAX_FILES}-file limit`);
    }
    const validated = await runWithConcurrency(sortedFiles, FILE_SCAN_CONCURRENCY, async (filePath) => {
        const realPath = await resolveActionSafePath(filePath, "scan target");
        const stats = await fs.stat(realPath);
        if (!stats.isFile()) {
            throw new Error(`normwinds: Action scan target is not a regular file: ${realPath}`);
        }
        return { filePath: realPath, size: stats.size };
    });
    const totalBytes = validated.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes > ACTION_MAX_TOTAL_SOURCE_BYTES) {
        throw new Error(`normwinds: Action scan exceeds the ${ACTION_MAX_TOTAL_SOURCE_BYTES}-byte source limit`);
    }
    return [...new Set(validated.map((entry) => entry.filePath))].sort((a, b) => a.localeCompare(b));
}

async function runWithConcurrency(items, concurrency, worker) {
    if (items.length === 0) {
        return [];
    }

    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, items.length);

    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (true) {
                const currentIndex = nextIndex;
                nextIndex += 1;
                if (currentIndex >= items.length) {
                    return;
                }

                results[currentIndex] = await worker(items[currentIndex], currentIndex);
            }
        }),
    );

    return results;
}

// Precompute class snippets and gather all arbitrary-value tokens up front,
// then canonicalize each unique cache miss once. Non-arbitrary tokens
// are never canonicalized because Tailwind's canonicalizer is a no-op for them
// (verified empirically: 0/27,060 non-arbitrary tokens changed in this
// codebase). This removes the majority of Tailwind design-system calls.
async function collectStaticShorthandFindings(filePaths, { suggestNamedThemeVars = false, themeCssPath = null } = {}) {
    // Pass 1: read every file, extract class snippets, and collect unique
    // arbitrary tokens across the entire set for cache pre-warming.
    const fileContexts = new Array(filePaths.length);
    const uniqueArbitraryRaws = new Set();
    const uniqueThemeVarRaws = new Set();
    const scanFailures = [];
    const scanSkipped = [];
    let lintedFiles = 0;
    await runWithConcurrency(filePaths, FILE_SCAN_CONCURRENCY, async (filePath, idx) => {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size > MAX_SCANNED_FILE_BYTES) {
                console.error(
                    `normwinds: skipping ${filePath} (${stats.size} bytes exceeds the ${MAX_SCANNED_FILE_BYTES}-byte scan limit)`,
                );
                scanSkipped.push({
                    filePath,
                    reason: `exceeds ${MAX_SCANNED_FILE_BYTES}-byte scan limit (${stats.size} bytes)`,
                });
                fileContexts[idx] = null;
                return;
            }
        } catch (error) {
            scanFailures.push({ filePath, stage: "stat", error });
            fileContexts[idx] = null;
            return;
        }

        let sourceText;
        try {
            sourceText = await fs.readFile(filePath, "utf8");
        } catch (error) {
            scanFailures.push({ filePath, stage: "read", error });
            fileContexts[idx] = null;
            return;
        }
        if (!sourceText.includes("-") && !sourceText.includes("!")) {
            lintedFiles += 1;
            fileContexts[idx] = null;
            return;
        }

        let snippets;
        try {
            snippets = extractClassLikeStrings(sourceText, {
                allowSingleTokenCanonical: filePath.endsWith(".vue"),
                filePath,
            });
        } catch (error) {
            scanFailures.push({ filePath, stage: "parse", error });
            fileContexts[idx] = null;
            return;
        }
        lintedFiles += 1;
        if (snippets.length === 0) {
            fileContexts[idx] = null;
            return;
        }

        // Collect arbitrary raw tokens (containing `[` or `(--`) for global
        // cache pre-warming. Also note which snippets need the
        // canonicalizer / theme-var resolver.
        const perSnippetArbitraryRaws = new Array(snippets.length);
        let hasAnyArbitrary = false;
        for (let i = 0; i < snippets.length; i++) {
            const snippet = snippets[i];
            const hasBracket = snippet.value.includes("[");
            const hasParenVar = suggestNamedThemeVars && snippet.value.includes("(--");
            if (!hasBracket && !hasParenVar) {
                perSnippetArbitraryRaws[i] = null;
                continue;
            }

            if (hasBracket) {
                hasAnyArbitrary = true;
            }
            const tokenRegex = /\S+/g;
            let match;
            const raws = [];
            while ((match = tokenRegex.exec(snippet.value)) !== null) {
                const raw = match[0];
                if (!isLikelyFixUtility(raw)) {
                    continue;
                }
                const isArbitrary = raw.includes("[");
                const isThemeVar = suggestNamedThemeVars && tokenLooksLikeNamedThemeVarCandidate(raw);
                if (!isArbitrary && !isThemeVar) {
                    continue;
                }
                raws.push({
                    raw,
                    snippetOffset: match.index,
                });
                if (isArbitrary) {
                    uniqueArbitraryRaws.add(raw);
                }
                if (isThemeVar) {
                    uniqueThemeVarRaws.add(raw);
                }
            }
            perSnippetArbitraryRaws[i] = raws;
        }

        fileContexts[idx] = {
            filePath,
            snippets,
            lineStarts: buildLineStarts(sourceText),
            perSnippetArbitraryRaws,
            hasAnyArbitrary,
            hasAnyThemeVarCandidate: suggestNamedThemeVars && sourceText.includes("(--"),
        };
    });

    // Determine which arbitrary tokens are NOT already cached. Only load
    // Tailwind if there are misses — a warm cache bypasses the ~1.4s
    // design-system initialization entirely.
    const cacheMisses = [];
    for (const raw of uniqueArbitraryRaws) {
        if (!CANONICAL_MEMO.has(raw)) {
            cacheMisses.push(raw);
        }
    }

    if (cacheMisses.length > 0) {
        if (cacheMisses.length > MAX_LIVE_CANONICALIZATION_CANDIDATES) {
            throw new Error(
                `normwinds: refusing to live-canonicalize ${cacheMisses.length} unique cache misses in one run (limit: ${MAX_LIVE_CANONICALIZATION_CANDIDATES}). Split the scan, regenerate the canonical snapshot, or warm the cache in smaller batches.`,
            );
        }
        const canonicalizeCandidate = await getCanonicalizeCandidate();
        for (const raw of cacheMisses) {
            canonicalizeCandidate(raw);
        }
    }

    // Pre-warm theme-var replacements (opt-in). Only when at least one
    // candidate token exists, to avoid loading the design system needlessly.
    // The resolver is loaded first so we know the active themeCssHash before
    // probing the on-disk cache; otherwise stale misses recorded under a
    // different theme CSS could be silently reused.
    if (suggestNamedThemeVars && uniqueThemeVarRaws.size > 0) {
        const themeVarResolver = await getThemeVarResolver({ themeCssPath }).catch((error) => {
            console.error(error?.message || String(error));
            return null;
        });
        if (themeVarResolver) {
            for (const raw of uniqueThemeVarRaws) {
                if (!CANONICAL_MEMO.has(buildThemeVarCacheKey(raw, activeThemeCssHash))) {
                    themeVarResolver(raw);
                }
            }
        }
    }

    // Pass 2: per-file scanning. Canonicalize lookups now hit the pre-warmed
    // memo, so no further design-system work happens in the hot loop.
    const perFileFindings = await runWithConcurrency(fileContexts, FILE_SCAN_CONCURRENCY, async (ctx) => {
        if (!ctx) {
            return [];
        }

        const {
            filePath,
            snippets,
            lineStarts,
            perSnippetArbitraryRaws,
            hasAnyArbitrary,
            hasAnyThemeVarCandidate,
        } = ctx;
        const relativePath = toRelative(filePath);
        const localFound = new Map();

        const ensureLineStarts = () => lineStarts;

        // If every arbitrary token is cached, we never loaded Tailwind.
        // Use the cache-only lookup; otherwise fall through to the full
        // canonicalizer (already warmed above).
        let canonicalizeCandidate = null;
        if (hasAnyArbitrary) {
            if (canonicalizerFnPromise) {
                canonicalizeCandidate = await canonicalizerFnPromise;
            } else {
                canonicalizeCandidate = lookupCanonicalFromMemo;
            }
        }

        let themeVarLookup = null;
        if (suggestNamedThemeVars && hasAnyThemeVarCandidate) {
            if (themeVarResolverPromise) {
                themeVarLookup = await themeVarResolverPromise.catch(() => null);
            } else {
                themeVarLookup = lookupThemeVarReplacementFromMemo;
            }
        }

        for (let si = 0; si < snippets.length; si++) {
            const snippet = snippets[si];
            const arbitraryRaws = perSnippetArbitraryRaws[si];

            if (arbitraryRaws && arbitraryRaws.length > 0) {
                const ls = ensureLineStarts();
                for (const { raw, snippetOffset } of arbitraryRaws) {
                    let suggestion = null;

                    if (canonicalizeCandidate && raw.includes("[")) {
                        const tailwindCanonical = canonicalizeCandidate(raw);
                        if (tailwindCanonical && tailwindCanonical !== raw) {
                            suggestion = tailwindCanonical;
                        }
                    }

                    // Chain canonicalize -> named-theme-var. When Tailwind
                    // canonicalizes `border-[var(--x)]/40` to `border-(--x)/40`,
                    // the resolver should still get a chance to collapse the
                    // var ref to the named utility (`border-x/40`). Operate on
                    // the post-canonical string so the final emitted suggestion
                    // is the most specific one we can prove safe.
                    const themeInput = suggestion ?? raw;
                    if (themeVarLookup && tokenLooksLikeNamedThemeVarCandidate(themeInput)) {
                        const themeReplacement = themeVarLookup(themeInput);
                        if (themeReplacement && themeReplacement !== themeInput) {
                            suggestion = themeReplacement;
                        }
                    }

                    if (suggestion) {
                        const { line, column } = indexToLineCol(ls, snippet.index + snippetOffset);
                        maybePushFinding(localFound, {
                            filePath: relativePath,
                            line,
                            column,
                            message: `The class '${raw}' can be written as '${suggestion}'`,
                        });
                    }
                }
            }

            const tokenRegex = /\S+/g;
            let tokenMatch;
            const parsedTokens = [];

            while ((tokenMatch = tokenRegex.exec(snippet.value)) !== null) {
                const token = parseClassToken(tokenMatch[0]);
                if (!isLikelyTailwindUtility(token)) {
                    continue;
                }

                parsedTokens.push(token);

                // v3 optimization: avoid the Tailwind canonicalizer for general
                // non-arbitrary tokens, but still report explicit known aliases.
                const knownCanonical = getKnownCanonicalClass(token.raw);
                if (knownCanonical || (token.importantPrefix && !token.importantSuffix)) {
                    const canonical = knownCanonical ?? formatClass(token.variants, true, token.utility);
                    const ls = ensureLineStarts();
                    const { line, column } = indexToLineCol(ls, snippet.index + tokenMatch.index);
                    maybePushFinding(localFound, {
                        filePath: relativePath,
                        line,
                        column,
                        message: `The class '${token.raw}' can be written as '${canonical}'`,
                    });
                }
            }

            if (parsedTokens.length > 1) {
                const grouped = new Map();
                for (const token of parsedTokens) {
                    const key = `${token.variants}|${token.important ? "1" : "0"}`;
                    if (!grouped.has(key)) {
                        grouped.set(key, []);
                    }

                    grouped.get(key).push(token);
                }

                const ls = ensureLineStarts();
                const snippetAnchor = indexToLineCol(ls, snippet.index);
                detectFamilyShorthand(grouped, relativePath, snippetAnchor.line, snippetAnchor.column, localFound);
                detectComplexEquivalences(grouped, relativePath, snippetAnchor.line, snippetAnchor.column, localFound);
            }
        }

        return [...localFound.values()];
    });

    const findings = perFileFindings.flat().sort(
        (a, b) =>
            a.filePath.localeCompare(b.filePath) ||
            a.line - b.line ||
            a.column - b.column ||
            a.message.localeCompare(b.message),
    );
    return {
        findings,
        lintedFiles,
        skipped: scanSkipped,
        failures: scanFailures,
    };
}

function printScanIssueSummary(skipped, failures) {
    if (skipped.length === 0 && failures.length === 0) {
        return;
    }
    console.error(
        `\nnormwinds: audit summary — ${skipped.length} skipped, ${failures.length} failed`,
    );
    for (const { filePath, reason } of skipped) {
        console.error(`  - ${filePath} [skipped]: ${reason}`);
    }
    for (const { filePath, stage, error } of failures) {
        console.error(`  - ${filePath} [failed:${stage}]: ${error?.message || String(error)}`);
    }
}

function printTextReport(findings, lintedFiles) {
    if (findings.length === 0) {
        console.log(`normwinds v${NORMWINDS_VERSION}: no shorthand/canonical findings in ${lintedFiles} files.`);
        return;
    }

    console.log(`normwinds v${NORMWINDS_VERSION}: ${findings.length} finding(s) across ${lintedFiles} linted file(s).`);

    let currentFile = "";
    for (const finding of findings) {
        if (finding.filePath !== currentFile) {
            currentFile = finding.filePath;
            console.log(`\n${currentFile}`);
        }

        console.log(
            `  ${String(finding.line).padStart(4)}:${String(finding.column).padEnd(3)} ${finding.message}`,
        );
    }

    console.log("\nRun with --fix (or --fixall) to apply safe rewrites automatically.");
}

async function main() {
    const {
        checkCanonical,
        cleanupCanonicalFiles,
        dryRun,
        extractCanonical,
        fix,
        fixAll,
        help,
        json,
        patterns,
        suggestNamedThemeVars,
        themeCssPath,
        version,
        writeCanonicalFiles,
        unknownFlags,
        missingValueFlags,
    } = parseArgs(process.argv.slice(2));

    if (help) {
        printHelp();
        return;
    }

    if (version) {
        console.log(NORMWINDS_VERSION);
        return;
    }

    if (unknownFlags.length > 0) {
        console.error(`normwinds: unknown flag(s): ${unknownFlags.join(", ")}`);
        console.error("Run `normwinds --help` for the list of supported flags.");
        process.exitCode = 2;
        return;
    }

    if (missingValueFlags.length > 0) {
        console.error(
            `normwinds: ${missingValueFlags.join(", ")} requires a value (e.g. --theme-css src/assets/main.css).`,
        );
        process.exitCode = 2;
        return;
    }

    if (suggestNamedThemeVars && !themeCssPath) {
        console.error(
            "normwinds: --suggest-named-theme-vars requires --theme-css <path-to-project-tailwind.css>.",
        );
        process.exitCode = 2;
        return;
    }

    // An explicitly-requested --theme-css that cannot be loaded is a
    // misconfiguration, not a degraded mode: fail loud up front instead of
    // silently disabling the feature for the whole run. The resolver promise
    // is cached, so this costs nothing when the path is valid.
    if (themeCssPath && !checkCanonical && !extractCanonical && !cleanupCanonicalFiles) {
        try {
            await getThemeVarResolver({ themeCssPath });
        } catch (error) {
            const reason = error?.message || String(error);
            console.error(
                reason.startsWith("normwinds:")
                    ? reason
                    : `normwinds: failed to load --theme-css "${themeCssPath}": ${reason}`,
            );
            process.exitCode = 2;
            return;
        }
    }

    if (cleanupCanonicalFiles) {
        await cleanupCanonicalArtifacts();
        console.log(`normwinds v${NORMWINDS_VERSION}: removed canonical generated artifacts (if present).`);
        return;
    }

    if (checkCanonical) {
        await extractCanonicalReplacements({ writeFiles: false, checkOnly: true });
        return;
    }

    if (extractCanonical) {
        await extractCanonicalReplacements({ writeFiles: writeCanonicalFiles });
        return;
    }

    const [filePaths] = await Promise.all([
        listTargetFiles(patterns),
        (async () => {
            await loadDiskCache();
            await loadCanonicalSnapshot();
        })(),
    ]);

    if (patterns.length > 0 && filePaths.length === 0) {
        console.error(
            `normwinds: the given pattern(s) matched no lintable files: ${patterns.join(", ")}`,
        );
    }

    let fixIssues = 0;
    if (fix) {
        const fixResult = await applyFixes(filePaths, { fixAll, suggestNamedThemeVars, themeCssPath, dryRun });
        fixIssues = fixResult.failed + fixResult.skipped;
    }

    const scanResult = await collectStaticShorthandFindings(filePaths, { suggestNamedThemeVars, themeCssPath });
    const {
        findings,
        lintedFiles,
        skipped: scanSkipped,
        failures: scanFailures,
    } = scanResult;
    printScanIssueSummary(scanSkipped, scanFailures);
    const scanIssues = scanSkipped.length + scanFailures.length;

    await saveDiskCache();

    if (json) {
        console.log(
            JSON.stringify(
                {
                    version: NORMWINDS_VERSION,
                    ruleId: RULE_ID,
                    lintedFiles,
                    findingCount: findings.length,
                    findings,
                },
                null,
                2,
            ),
        );
    } else {
        printTextReport(findings, lintedFiles);
    }

    // Exit 2 distinguishes a partial-failure run (some files couldn't be written)
    // from a clean audit (0) or one that merely found lint issues (1), so CI can
    // tell the difference.
    process.exitCode = fixIssues > 0 || scanIssues > 0 ? 2 : findings.length > 0 ? 1 : 0;
}

main().catch((error) => {
    console.error("normwinds: failed to run shorthand audit.");
    console.error(error);
    process.exitCode = 2;
});
