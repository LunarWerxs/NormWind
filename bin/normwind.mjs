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
import { ROOT_FONT_SIZE_PX } from "../lib/constants.mjs";
import {
    cssRuleBodiesAreEquivalent,
    maskCssComments,
    winningDeclarations,
} from "../lib/css.mjs";
import { globPatternToRegExp, hasGlobSyntax } from "../lib/glob.mjs";
import { sendInstallPing } from "../lib/ping.mjs";
import { buildSarifReport } from "../lib/sarif.mjs";
import {
    buildLineStarts,
    findBalancedBraceEnd,
    findRawElementClose,
    indexToLineCol,
    parseMarkupTag,
    splitTemplateStaticChunks,
} from "../lib/text.mjs";
import {
    buildFixToken,
    formatClass,
    getKnownCanonicalClass,
    getUtilityBodyCandidates,
    isLikelyFixUtility,
    isLikelyTailwindUtility,
    matchFixBodyValue,
    matchUtilityToBody,
    parseClassToken,
    parseFixToken,
    stripBracketedSegments,
} from "../lib/tokens.mjs";
import {
    expandValueVariants,
    extractFractionPercent,
    multiplyLength,
} from "../lib/units.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundledRequire = createRequire(import.meta.url);

// Single source of truth: npm always includes package.json in the published
// tarball, so the version is read from it rather than duplicated here.
const NORMWINDS_VERSION = bundledRequire("../package.json").version;
const RULE_ID = "tailwindcss/enforces-shorthand";
const DEFAULT_PATTERNS = ["**/*.{vue,svelte,astro,html,js,mjs,cjs,ts,jsx,tsx,mts,cts}"];
// Markup-first formats: a class attribute is the dominant shape, so a single
// bracket-bearing token in one is worth canonicalizing on its own, and `--fix`
// (as opposed to `--fixall`) covers them.
const MARKUP_EXTENSIONS = new Set([".vue", ".svelte", ".astro", ".html", ".htm"]);
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
// Directory names that are never hand-authored source, at ANY depth.
const IGNORED_SEGMENTS = new Set([
    ".git",
    ".venv",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".astro",
    ".turbo",
    "cdk.out",
    "dist",
    "node_modules",
    "storybook-static",
    "test-results",
]);
// Names that are conventionally build output at the project root but are
// perfectly ordinary source directory names further down (`src/lib/build/`,
// `app/components/out/`), so they are only ignored at the root.
const IGNORED_ROOT_PREFIXES = [
    ".cache/",
    ".tmp/",
    "build/",
    "coverage/",
    "dist/",
    "out/",
    "test-results/",
    "vendor/",
];
const IGNORED_EXACT_PATHS = new Set();

// The ripgrep glob list and the walkDirectory sets above must describe the
// SAME contract - rg additionally honors .gitignore, so anything that relies
// on .gitignore alone would silently diverge on machines without rg. Derive
// the globs from the sets so the two can never drift apart by hand.
const RG_IGNORE_GLOBS = [
    ...[...IGNORED_SEGMENTS].flatMap((segment) => [`!${segment}/**`, `!**/${segment}/**`]),
    ...IGNORED_ROOT_PREFIXES.map((prefix) => `!${prefix}**`),
    ...[...IGNORED_EXACT_PATHS].map((exact) => `!${exact}`),
];

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

// Portable form of a resolved dependency path, for anything that gets written into a
// committed artifact.
//
// `require.resolve` returns the REAL path, and a package does not have to live inside the
// package root: under a shared/global package store (bun's isolated linker + globalStore,
// pnpm, yarn) `node_modules/<pkg>` is a symlink and the real file sits outside the checkout
// entirely. `path.relative(PACKAGE_ROOT, ...)` then produces machine-specific `../../..`
// noise, and --check-canonical fails on every machine whose store is somewhere else.
//
// Fall back to the node_modules-relative form, which is stable across every layout.
function toPortableModulePath(root, absolutePath) {
    const relative = path.relative(root, absolutePath).replace(/\\/g, "/");
    if (!relative.startsWith("../")) return relative;
    const posix = absolutePath.replace(/\\/g, "/");
    const marker = posix.lastIndexOf("/node_modules/");
    return marker === -1 ? relative : posix.slice(marker + 1);
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
// is treated as a package/runtime import and dropped. Tailwind's own CSS is
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


async function inlineLocalCssImports(sourceCss, sourcePath, visited, budget) {
    const sourceDir = path.dirname(sourcePath);
    const parts = [];
    let lastIndex = 0;
    // A commented-out `@import "./old-theme.css";` is not an import. Match
    // against a comment-masked copy (same length, so every index still lines
    // up) and slice the real text.
    const scannable = maskCssComments(sourceCss);
    // A fresh RegExp per recursion frame is required. Sharing the module-level
    // global instance lets a nested import reset its parent's lastIndex, which
    // can duplicate the CSS between imports and change last-declaration-wins
    // @theme semantics.
    const importRegex = new RegExp(CSS_IMPORT_REGEX.source, CSS_IMPORT_REGEX.flags);

    let match;
    while ((match = importRegex.exec(scannable)) !== null) {
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
            // Already inlined upstream, so skip it to avoid cycles and
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
        // Cache persistence is best-effort; never fail the run.
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
    const { tailwindPkg, tailwindRequire, tailwindIndexCssPath: configuredCssPath } = loadTailwind();

    // A snapshot's identity is not the Tailwind version alone: canonicalization
    // results also depend on which CSS entry produced them and on the rem base.
    // extractCanonicalReplacements records both, so validate both. Resolving
    // the CSS path is a plain require.resolve, not a design-system load.
    let expectedIndexCssPath = null;
    try {
        expectedIndexCssPath = toPortableModulePath(
            PACKAGE_ROOT,
            configuredCssPath || tailwindRequire.resolve("tailwindcss/index.css"),
        );
    } catch {
        // Unresolvable here means the snapshot cannot be validated against a
        // known entry; fall back to accepting on version alone rather than
        // discarding a snapshot that is probably fine.
    }

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
            if (
                expectedIndexCssPath &&
                typeof parsed.source?.tailwindIndexCssPath === "string" &&
                parsed.source.tailwindIndexCssPath !== expectedIndexCssPath
            ) {
                continue;
            }
            if (
                parsed.source?.rootFontSizePx !== undefined &&
                parsed.source.rootFontSizePx !== ROOT_FONT_SIZE_PX
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
            if (typeof designSystem.canonicalizeCandidates !== "function") {
                // --extract-canonical throws for exactly this condition; the
                // scan path degrades instead, but silently degrading a whole
                // class of fixes with no signal is worse than a warning.
                const { tailwindPkg, source } = loadTailwind();
                console.error(
                    `normwinds: the resolved Tailwind (${source} v${tailwindPkg.version}) does not expose canonicalizeCandidates; arbitrary-value canonicalization is disabled for this run.`,
                );
            }
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

// ---------------------------------------------------------------------------
// Merge safety
//
// A shorthand merge is only sound when the class list renders identically
// before and after. Collapsing `ml-2 mr-2` into `mx-2` moves the declaration
// from the per-side level up to the axis level, and Tailwind emits utilities
// in ITS OWN order (broad before narrow, and same-utility candidates sorted
// by value) rather than in authoring order. So a pre-existing `mx-8` that the
// two sides used to override starts winning after the merge, silently
// changing the rendered margin. The same trap applies to `w-*`/`h-*` ->
// `size-*` and to every four-sides/corner rule.
//
// The cheap syntactic pre-filter (mergeHasValueConflict) finds the only shape
// that can go wrong: another token in the same variant/important group that
// shares a body with the merge target or one of its sources at a different
// value. Only then is Tailwind consulted for the authoritative answer, so the
// overwhelmingly common case still never loads the design system.
//
// When Tailwind cannot answer (older engine, load failure, cold cache in a
// path that cannot await), the merge is refused. Refusing costs a suggestion;
// allowing costs the user a silent visual regression.
// ---------------------------------------------------------------------------
const MERGE_SAFETY_CACHE_PREFIX = "mergesafe:";
const MAX_MERGE_SAFETY_KEY_LENGTH = 4096;
// Each round resolves the pairs the previous one could not answer. Merges are
// iterative, so a later merge only becomes visible once an earlier one lands.
// Every round strictly grows the memo, so this terminates well before the cap.
const MAX_MERGE_SAFETY_ROUNDS = 6;

function buildMergeSafetyKey(before, after) {
    // Commas, not spaces: isSafeCacheEntry rejects whitespace in cache keys so
    // the entry can round-trip through the on-disk cache.
    return `${MERGE_SAFETY_CACHE_PREFIX}${before.join(",")}=>${after.join(",")}`;
}




let mergeSafetyPromise = null;
async function getMergeSafetyChecker() {
    if (!mergeSafetyPromise) {
        mergeSafetyPromise = (async () => {
            validateCacheAgainstTailwindVersion();
            const { designSystem } = await loadTailwindDesignSystem();
            if (
                typeof designSystem.getClassOrder !== "function" ||
                typeof designSystem.candidatesToCss !== "function"
            ) {
                return null;
            }

            return (before, after) => {
                const key = buildMergeSafetyKey(before, after);
                if (key.length > MAX_MERGE_SAFETY_KEY_LENGTH) {
                    return false;
                }
                const cached = CANONICAL_MEMO.get(key);
                if (cached !== undefined) {
                    return cached === "1";
                }

                const beforeDeclarations = winningDeclarations(designSystem, before);
                const afterDeclarations = winningDeclarations(designSystem, after);
                let safe = false;
                if (
                    beforeDeclarations &&
                    afterDeclarations &&
                    beforeDeclarations.size === afterDeclarations.size
                ) {
                    safe = true;
                    for (const [property, value] of beforeDeclarations) {
                        if (afterDeclarations.get(property) !== value) {
                            safe = false;
                            break;
                        }
                    }
                }

                CANONICAL_MEMO.set(key, safe ? "1" : "0");
                DYNAMIC_CACHE_KEYS.add(key);
                diskCacheDirty = true;
                return safe;
            };
        })();
    }
    return mergeSafetyPromise;
}

// Memo-only view of the same answer, for hot paths that must stay synchronous
// and cannot await the design system. `undefined` means "never resolved".
function lookupMergeSafetyFromMemo(before, after) {
    const key = buildMergeSafetyKey(before, after);
    if (key.length > MAX_MERGE_SAFETY_KEY_LENGTH) {
        return false;
    }
    const cached = CANONICAL_MEMO.get(key);
    return cached === undefined ? undefined : cached === "1";
}

// A probe answers from the memo and records anything it cannot answer, so a
// caller can resolve the whole batch with one design-system load and replay.
// Used by both the audit sweep and the fix pass; a run whose class lists have
// no conflicting siblings records nothing and never loads Tailwind at all.
function createMergeSafetyProbe() {
    const pending = [];
    const seen = new Set();
    const probe = (before, after) => {
        const verdict = lookupMergeSafetyFromMemo(before, after);
        if (verdict !== undefined) {
            return verdict;
        }
        const key = buildMergeSafetyKey(before, after);
        if (!seen.has(key)) {
            seen.add(key);
            pending.push([before, after]);
        }
        return undefined;
    };
    probe.pending = pending;
    return probe;
}

// Resolve everything a probe recorded. Returns true when the memo now has an
// answer for every pending pair, so the caller can replay against it.
async function resolvePendingMergeChecks(pending) {
    if (pending.length === 0) {
        return false;
    }
    const mergeSafety = await getMergeSafetyChecker().catch((error) => {
        console.error(
            `normwinds: could not load Tailwind to verify shorthand merge safety; affected suggestions were skipped (${error?.message || String(error)})`,
        );
        return null;
    });
    if (!mergeSafety) {
        return false;
    }
    for (const [before, after] of pending) {
        mergeSafety(before, after);
    }
    return true;
}

// True when another token in the same group shares a body with the merge
// target or one of its sources at a DIFFERENT value. That is the only shape
// in which a merge can change which declaration wins.
function mergeHasValueConflict(bodyValues, family, sourceShorthands, targetShorthand, negValue) {
    if (!bodyValues) {
        return false;
    }
    for (const shorthand of [targetShorthand, ...sourceShorthands]) {
        const body = family.shorthandToBody.get(shorthand);
        if (!body) {
            continue;
        }
        const seen = bodyValues.get(body);
        if (!seen) {
            continue;
        }
        for (const candidate of seen) {
            if (candidate !== negValue) {
                return true;
            }
        }
    }
    return false;
}

// Shared decision for both the audit and the fix path: given the raw tokens of
// one variant/important group, is replacing `sourceRaws` with `targetRaw`
// render-identical? `mergeSafety` is the resolved checker (or null/undefined
// when Tailwind was never loaded), and a conflict it cannot answer is refused.
function mergeIsRenderSafe(groupRaws, sourceRaws, targetRaw, hasConflict, mergeSafety) {
    if (!hasConflict) {
        return true;
    }
    if (typeof mergeSafety !== "function") {
        return false;
    }
    const consumed = new Set(sourceRaws);
    const after = [];
    let inserted = false;
    for (const raw of groupRaws) {
        if (consumed.has(raw)) {
            if (!inserted) {
                after.push(targetRaw);
                inserted = true;
            }
            continue;
        }
        after.push(raw);
    }
    if (!inserted) {
        after.push(targetRaw);
    }
    const verdict = mergeSafety(groupRaws, after);
    return verdict === true;
}


const KNOWN_FLAGS = new Set([
    "--allow-empty",
    "--check-canonical",
    "--cleanup-canonical-files",
    "--dry-run",
    "--extract-canonical",
    "--fix",
    "--fixall",
    "--help",
    "-h",
    "--ignore",
    "--json",
    "--reporter",
    "--suggest-named-theme-vars",
    "--theme-css",
    "--version",
    "-v",
    "--write-canonical-files",
]);
const VALUE_FLAGS = new Set(["--ignore", "--reporter", "--theme-css"]);
// Flags that accumulate instead of last-one-wins.
const REPEATABLE_VALUE_FLAGS = new Set(["--ignore"]);
const REPORTERS = new Set(["text", "json", "sarif"]);

function parseArgs(argv) {
    const flags = new Set();
    const patterns = [];
    const valueFlags = Object.create(null);
    const repeatedValues = Object.create(null);
    const unknownFlags = [];
    const missingValueFlags = [];
    let sawSeparator = false;

    const recordValue = (key, value) => {
        valueFlags[key] = value;
        if (REPEATABLE_VALUE_FLAGS.has(key)) {
            (repeatedValues[key] ??= []).push(value);
        }
        flags.add(key);
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        // Everything after a bare `--` is a positional target, even if it
        // starts with a dash. Without this a file literally named `-weird.vue`
        // was unreachable.
        if (!sawSeparator && arg === "--") {
            sawSeparator = true;
            continue;
        }
        if (sawSeparator) {
            patterns.push(arg);
            continue;
        }

        if (arg.startsWith("--")) {
            // Support `--key=value` and `--key value` for value-bearing flags.
            const eqIdx = arg.indexOf("=");
            if (eqIdx > 0) {
                const key = arg.slice(0, eqIdx);
                if (!KNOWN_FLAGS.has(key)) {
                    unknownFlags.push(key);
                    continue;
                }
                recordValue(key, arg.slice(eqIdx + 1));
                continue;
            }

            if (!KNOWN_FLAGS.has(arg)) {
                unknownFlags.push(arg);
                continue;
            }

            if (VALUE_FLAGS.has(arg)) {
                if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
                    recordValue(arg, argv[i + 1]);
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
        // typo'd flag, not a file pattern, so surface it instead of silently
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

    // --json is the long-standing alias for --reporter json and stays
    // supported; an explicit --reporter wins when both are given.
    const requestedReporter = valueFlags["--reporter"] ?? (flags.has("--json") ? "json" : "text");
    const reporter = REPORTERS.has(requestedReporter) ? requestedReporter : null;

    return {
        allowEmpty: flags.has("--allow-empty"),
        checkCanonical: flags.has("--check-canonical"),
        cleanupCanonicalFiles: flags.has("--cleanup-canonical-files"),
        dryRun: flags.has("--dry-run"),
        extractCanonical: flags.has("--extract-canonical"),
        fix: flags.has("--fix") || flags.has("--fixall"),
        fixAll: flags.has("--fixall"),
        help: flags.has("--help") || flags.has("-h"),
        ignorePatterns: repeatedValues["--ignore"] ?? [],
        json: reporter === "json",
        reporter,
        invalidReporter: reporter === null ? requestedReporter : null,
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
  With no patterns, the default scan is
  **/*.{vue,svelte,astro,html,js,mjs,cjs,ts,jsx,tsx,mts,cts} from the current
  directory, skipping .git, node_modules, dist, coverage, build output and
  other generated folders. Use \`--\` to end flag parsing when a target starts
  with a dash.

Exit codes:
  0 no findings   1 findings reported   2 usage or runtime error

Flags:
  --fix                       Auto-fix supported transforms in .vue files
  --fixall                    Auto-fix in all matched files (.vue/.js/.mjs/.ts/.jsx/.tsx)
  --dry-run                   With --fix/--fixall, show which files WOULD be
                              rewritten without writing anything to disk.
  --json                      Emit findings as JSON (alias for --reporter json)
  --reporter <text|json|sarif>
                              Output format. \`sarif\` emits SARIF 2.1.0 for
                              GitHub code scanning and similar CI dashboards.
  --ignore <glob>             Skip paths matching this glob. Repeatable. A
                              project-local .normwindignore file (one glob per
                              line, # for comments) is also read automatically.
  --allow-empty               Exit 0 instead of 2 when the given pattern(s)
                              match no lintable files.
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
            tailwindIndexCssPath: toPortableModulePath(PACKAGE_ROOT, tailwindIndexCssPath),
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












// Locate the first family merge the audit would report for the current token
// list. Tokens are grouped by variant prefix + important flag and then handed
// to the SAME clusterTokensByFamily the audit uses, so the two paths can never
// disagree about which merges exist.
function findFamilyMerge(tokens, mergeSafety = null) {
    const parsed = tokens.map((raw) => parseFixToken(raw));
    const groups = new Map();
    for (let i = 0; i < parsed.length; i += 1) {
        const groupKey = `${parsed[i].variants}|${parsed[i].important ? "1" : "0"}`;
        if (!groups.has(groupKey)) {
            groups.set(groupKey, []);
        }
        groups.get(groupKey).push(i);
    }

    for (const groupIndices of groups.values()) {
        const groupRaws = groupIndices.map((index) => tokens[index]);
        const { familyClusters, familyBodyValues } = clusterTokensByFamily(groupIndices, {
            getUtility: (index) => parsed[index].utility,
            getSlot: (index) => index,
        });

        for (const [family, clusters] of familyClusters.entries()) {
            const bodyValues = familyBodyValues.get(family);

            for (const [clusterKey, cluster] of clusters.entries()) {
                const { negative, value, shorthands } = cluster;

                for (const rule of FAMILY_MERGE_RULES) {
                    if (rule.corners && !family.supportsCorners) {
                        continue;
                    }
                    const targetBody = family.shorthandToBody.get(rule.target);
                    if (!targetBody) {
                        continue;
                    }
                    // Parity with detectFamilyShorthand: when the target
                    // shorthand is already present the audit stays silent, so
                    // the fixer must not rewrite either. Without this the
                    // fixer collapsed `p-4 px-4 py-4` to `p-4` on a file the
                    // audit had just declared clean.
                    if (shorthands.has(rule.target)) {
                        continue;
                    }

                    const indices = rule.sources.map((shorthand) => shorthands.get(shorthand));
                    if (indices.some((index) => index === undefined)) {
                        continue;
                    }

                    const ordered = [...indices].sort((a, b) => a - b);
                    const base = parsed[ordered[0]];
                    const targetUtility = `${negative}${targetBody}${value ? `-${value}` : ""}`;
                    const targetRaw = buildFixToken({
                        variants: base.variants,
                        utility: targetUtility,
                        important: base.important,
                    });

                    const conflict = mergeHasValueConflict(
                        bodyValues,
                        family,
                        rule.sources,
                        rule.target,
                        clusterKey,
                    );
                    if (!mergeIsRenderSafe(
                        groupRaws,
                        ordered.map((index) => tokens[index]),
                        targetRaw,
                        conflict,
                        mergeSafety,
                    )) {
                        continue;
                    }

                    return { indices: ordered, targetUtility };
                }
            }
        }
    }

    return null;
}

// Fix-side mirror of detectFamilyShorthand: apply the family merges the audit
// reports, one at a time, reclustering after each so a merged token can feed
// the next rule (rounded-tl + rounded-tr -> rounded-t, border-y + border-x ->
// border). Every merge removes at least one token, so the loop terminates.
function mergeFixFamilyShorthand(tokens, mergeSafety = null) {
    let changed = false;

    // findFamilyMerge now refuses a rule whose target shorthand already exists
    // in the same cluster, so the old post-hoc "existingTarget" dedup can no
    // longer fire and has been removed with it.
    for (
        let merge = findFamilyMerge(tokens, mergeSafety);
        merge;
        merge = findFamilyMerge(tokens, mergeSafety)
    ) {
        const { indices, targetUtility } = merge;
        const base = parseFixToken(tokens[indices[0]]);
        const targetRaw = buildFixToken({
            variants: base.variants,
            utility: targetUtility,
            important: base.important,
        });

        // Preserve the position of the earliest source token so unrelated
        // utilities keep their relative order in the output.
        tokens[indices[0]] = targetRaw;
        for (let k = indices.length - 1; k >= 1; k -= 1) {
            tokens.splice(indices[k], 1);
        }

        changed = true;
    }

    return changed;
}

const SIZE_MERGE_BODIES = ["w", "h", "size"];

// Index the w-/h-/size- tokens of one variant/important group: the first index
// per (body, value), and every value seen per body. One linear pass, which is
// also what removed the old O(n^2)-with-restart scan.
function indexSizeGroup(parsed, groupIndices) {
    const firstIndexByBodyValue = new Map();
    const valuesByBody = new Map();

    for (const index of groupIndices) {
        for (const body of SIZE_MERGE_BODIES) {
            const matched = matchFixBodyValue(parsed[index].utility, body);
            if (!matched || matched.negative || !matched.value) {
                continue;
            }
            const key = `${body}|${matched.value}`;
            if (!firstIndexByBodyValue.has(key)) {
                firstIndexByBodyValue.set(key, index);
            }
            if (!valuesByBody.has(body)) {
                valuesByBody.set(body, new Set());
            }
            valuesByBody.get(body).add(matched.value);
        }
    }

    return { firstIndexByBodyValue, valuesByBody };
}

// A w-/h- pair only collapses safely when no other w-, h-, or size- token in
// the same group carries a different value. `w-4 w-6 h-6` used to become
// `w-4 size-6`, which silently changed the rendered width from 6 to 4 because
// Tailwind emits size- before w-.
function sizeMergeHasValueConflict(valuesByBody, value) {
    for (const body of SIZE_MERGE_BODIES) {
        const seen = valuesByBody.get(body);
        if (!seen) {
            continue;
        }
        for (const candidate of seen) {
            if (candidate !== value) {
                return true;
            }
        }
    }
    return false;
}

function findWidthHeightMerge(tokens, parsed, groupIndices, mergeSafety) {
    const { firstIndexByBodyValue, valuesByBody } = indexSizeGroup(parsed, groupIndices);
    const groupRaws = groupIndices.map((index) => tokens[index]);

    for (const value of valuesByBody.get("w") ?? []) {
        const widthIndex = firstIndexByBodyValue.get(`w|${value}`);
        const heightIndex = firstIndexByBodyValue.get(`h|${value}`);
        if (widthIndex === undefined || heightIndex === undefined) {
            continue;
        }
        // Audit parity: detectComplexEquivalences stays silent when the target
        // size- utility is already present, so the fixer must too.
        if (valuesByBody.get("size")?.has(value)) {
            continue;
        }

        const base = parsed[Math.min(widthIndex, heightIndex)];
        const targetRaw = buildFixToken({
            variants: base.variants,
            utility: `size-${value}`,
            important: base.important,
        });

        const conflict = sizeMergeHasValueConflict(valuesByBody, value);
        if (!mergeIsRenderSafe(
            groupRaws,
            [tokens[widthIndex], tokens[heightIndex]],
            targetRaw,
            conflict,
            mergeSafety,
        )) {
            continue;
        }

        return {
            // Preserve the position of the earlier token so unrelated
            // utilities keep their relative order in the output.
            firstIndex: Math.min(widthIndex, heightIndex),
            secondIndex: Math.max(widthIndex, heightIndex),
            targetRaw,
        };
    }

    return null;
}

function mergeFixWidthHeight(tokens, mergeSafety = null) {
    let mutated = false;

    for (let pass = true; pass; ) {
        pass = false;
        const parsed = tokens.map((raw) => parseFixToken(raw));
        const groups = new Map();
        for (let i = 0; i < parsed.length; i += 1) {
            const groupKey = `${parsed[i].variants}|${parsed[i].important ? "1" : "0"}`;
            if (!groups.has(groupKey)) {
                groups.set(groupKey, []);
            }
            groups.get(groupKey).push(i);
        }

        for (const groupIndices of groups.values()) {
            const merge = findWidthHeightMerge(tokens, parsed, groupIndices, mergeSafety);
            if (!merge) {
                continue;
            }
            tokens[merge.firstIndex] = merge.targetRaw;
            tokens.splice(merge.secondIndex, 1);
            mutated = true;
            // Every merge removes a token, so this terminates; indices are
            // stale after the splice, so recompute rather than patch them.
            pass = true;
            break;
        }
    }

    return mutated;
}

function looksLikeFixableClassString(content, { allowSingleTokenCanonical = false } = {}) {
    // Operator characters that hint at JSX/JS expressions are only
    // disqualifying when they appear OUTSIDE of Tailwind's arbitrary-value
    // brackets (`[...]`) or theme-var parens (`(...)`). A class string
    // containing `data-[state=open]:text-...` or `hover:text-(--color-x)`
    // is still a plain class string and must be considered fixable. The
    // character set must stay identical to shouldExtractQuotedClassValue's:
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

function transformFixableClassContent(
    content,
    canonicalizeCandidate,
    themeVarResolver = null,
    mergeSafety = null,
) {
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
        merged = mergeFixFamilyShorthand(tokens, mergeSafety) || merged;
        merged = mergeFixWidthHeight(tokens, mergeSafety) || merged;
        merged = mergeFixCompositeEquivalences(tokens, mergeSafety) || merged;
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
    mergeSafety = null,
    filePath = null,
} = {}) {
    let changed = false;
    let current = text;

    // The fixer rewrites exactly the spans the audit extracts; nothing else
    // in the file is ever touched. Spans can nest (a quoted string inside a
    // :class expression sits inside the attribute-value span), so each pass
    // applies edits right-to-left, preferring the innermost span on overlap;
    // the convergence loop then re-collects spans so a parent-level merge
    // exposed by a nested rewrite still lands. The cap only guards against a
    // hypothetical rewrite cycle; real inputs settle in one or two passes.
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

            const next = transformFixableClassContent(
                span.value,
                canonicalizeCandidate,
                themeVarResolver,
                mergeSafety,
            );
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
        if (!fixAll && !isMarkupFile(filePath)) {
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
        // on Windows) or ENOSPC, must skip this one file and continue, not stop
        // the whole run. The write itself stays atomic (temp file + rename).
        try {
            // Test-only hook (mirrors NORMWIND_DISABLE_CANONICAL_SNAPSHOT) that
            // forces a transform throw for one named file, so the fault-isolation
            // contract can be exercised deterministically without crafting input
            // that happens to break the real parser.
            if (process.env.NORMWIND_TEST_FORCE_TRANSFORM_THROW === path.basename(filePath)) {
                throw new Error("normwinds: forced transform throw (NORMWIND_TEST_FORCE_TRANSFORM_THROW)");
            }

            const allowSingleTokenCanonical = isMarkupFile(filePath);
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
            // Merge safety is resolved lazily: each attempt answers from the
            // memo and records the pairs it cannot answer, then those are
            // resolved and the transform replayed. Merges are iterative, so a
            // second round can expose a pair the first never reached; loop
            // until nothing new is recorded. Only a file that actually contains
            // a conflicting class list pays for the design system, and after
            // the first such file the memo serves the rest.
            let changed = false;
            let transformed = sourceText;
            for (let round = 0; round < MAX_MERGE_SAFETY_ROUNDS; round += 1) {
                const probe = createMergeSafetyProbe();
                ({ changed, transformed } = applyFixesToText(sourceText, canonicalizeCandidate, {
                    allowSingleTokenCanonical,
                    themeVarResolver,
                    mergeSafety: probe,
                    filePath,
                }));
                if (!(await resolvePendingMergeChecks(probe.pending))) {
                    break;
                }
            }
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
            // the user's source file truncated: the original stays intact until
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
            `\nnormwinds: fix summary: ${changedFiles} ${dryRun ? "would-fix" : "fixed"}, ${skipped.length} skipped, ${failures.length} failed`,
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

// Composite equivalences: fixed multi-utility sets that Tailwind ships a
// single named utility for. Unlike the family merges these have no value axis,
// so the whole rule is a literal source set and a literal target.
//
// One table, consumed by BOTH the audit (detectComplexEquivalences) and the
// fixer (mergeFixCompositeEquivalences). Before this table existed the audit
// reported truncate/place-* findings that no fixer could ever apply, so
// `normwind --fixall && normwind` stayed at exit 1 forever.
function buildCompositeEquivalenceRules() {
    const rules = [
        {
            target: "truncate",
            sources: ["overflow-hidden", "text-ellipsis", "whitespace-nowrap"],
        },
    ];

    for (const option of COMPLEX_EQUIVALENCES.placeContentOptions) {
        rules.push({
            target: `place-content-${option}`,
            sources: [`content-${option}`, `justify-${option}`],
        });
    }
    for (const option of COMPLEX_EQUIVALENCES.placeItemsOptions) {
        rules.push({
            target: `place-items-${option}`,
            sources: [`items-${option}`, `justify-items-${option}`],
        });
    }
    for (const option of COMPLEX_EQUIVALENCES.placeSelfOptions) {
        rules.push({
            target: `place-self-${option}`,
            sources: [`self-${option}`, `justify-self-${option}`],
        });
    }

    for (const rule of rules) {
        // Any other utility sharing a leading segment with the target or a
        // source could set one of the same properties, which is the only way
        // collapsing the set can change what wins.
        rule.guardedPrefixes = new Set(
            [rule.target, ...rule.sources].map((utility) => utility.split("-")[0]),
        );
        rule.sourceSet = new Set(rule.sources);
    }

    return rules;
}

const COMPOSITE_EQUIVALENCE_RULES = buildCompositeEquivalenceRules();

function compositeHasConflict(groupUtilities, rule) {
    for (const utility of groupUtilities) {
        if (rule.sourceSet.has(utility) || utility === rule.target) {
            continue;
        }
        if (rule.guardedPrefixes.has(utility.split("-")[0])) {
            return true;
        }
    }
    return false;
}

function detectComplexEquivalences(groupedTokens, filePath, line, column, found, mergeSafety = null) {
    for (const tokens of groupedTokens.values()) {
        const utilities = new Set(tokens.map((token) => token.utility));
        const byUtility = new Map(tokens.map((token) => [token.utility, token]));
        const groupRaws = tokens.map((token) => token.raw);

        for (const rule of COMPOSITE_EQUIVALENCE_RULES) {
            if (utilities.has(rule.target) || !rule.sources.every((source) => utilities.has(source))) {
                continue;
            }
            const sources = rule.sources.map((source) => byUtility.get(source));
            const target = formatClass(tokens[0].variants, tokens[0].important, rule.target);
            if (!mergeIsRenderSafe(
                groupRaws,
                sources.map((token) => token.raw),
                target,
                compositeHasConflict(utilities, rule),
                mergeSafety,
            )) {
                continue;
            }
            emitSuggestion(found, filePath, line, column, sources, target);
        }

        // w-/h- -> size-. Same guard as the fixer's findWidthHeightMerge: the
        // pair only collapses when no other w-/h-/size- token in the group
        // carries a different value.
        const sizeIndices = tokens.map((_, index) => index);
        const { firstIndexByBodyValue, valuesByBody } = indexSizeGroup(tokens, sizeIndices);

        for (const value of valuesByBody.get("w") ?? []) {
            const widthIndex = firstIndexByBodyValue.get(`w|${value}`);
            const heightIndex = firstIndexByBodyValue.get(`h|${value}`);
            if (widthIndex === undefined || heightIndex === undefined) {
                continue;
            }
            if (valuesByBody.get("size")?.has(value)) {
                continue;
            }

            const widthToken = tokens[widthIndex];
            const heightToken = tokens[heightIndex];
            const target = formatClass(widthToken.variants, widthToken.important, `size-${value}`);
            if (!mergeIsRenderSafe(
                groupRaws,
                [widthToken.raw, heightToken.raw],
                target,
                sizeMergeHasValueConflict(valuesByBody, value),
                mergeSafety,
            )) {
                continue;
            }

            emitSuggestion(found, filePath, line, column, [widthToken, heightToken], target);
        }
    }
}

// Fix-side mirror of the composite table above.
function mergeFixCompositeEquivalences(tokens, mergeSafety = null) {
    let mutated = false;

    for (let pass = true; pass; ) {
        pass = false;
        const parsed = tokens.map((raw) => parseFixToken(raw));
        const groups = new Map();
        for (let i = 0; i < parsed.length; i += 1) {
            const groupKey = `${parsed[i].variants}|${parsed[i].important ? "1" : "0"}`;
            if (!groups.has(groupKey)) {
                groups.set(groupKey, []);
            }
            groups.get(groupKey).push(i);
        }

        for (const groupIndices of groups.values()) {
            const groupRaws = groupIndices.map((index) => tokens[index]);
            const utilities = new Set(groupIndices.map((index) => parsed[index].utility));
            const firstIndexByUtility = new Map();
            for (const index of groupIndices) {
                if (!firstIndexByUtility.has(parsed[index].utility)) {
                    firstIndexByUtility.set(parsed[index].utility, index);
                }
            }

            let applied = false;
            for (const rule of COMPOSITE_EQUIVALENCE_RULES) {
                if (utilities.has(rule.target) || !rule.sources.every((source) => utilities.has(source))) {
                    continue;
                }
                const indices = rule.sources
                    .map((source) => firstIndexByUtility.get(source))
                    .sort((a, b) => a - b);
                const base = parsed[indices[0]];
                const targetRaw = buildFixToken({
                    variants: base.variants,
                    utility: rule.target,
                    important: base.important,
                });
                if (!mergeIsRenderSafe(
                    groupRaws,
                    indices.map((index) => tokens[index]),
                    targetRaw,
                    compositeHasConflict(utilities, rule),
                    mergeSafety,
                )) {
                    continue;
                }

                tokens[indices[0]] = targetRaw;
                for (let k = indices.length - 1; k >= 1; k -= 1) {
                    tokens.splice(indices[k], 1);
                }
                mutated = true;
                applied = true;
                break;
            }

            if (applied) {
                // Indices are stale after the splice; recompute. Every merge
                // removes at least one token, so this terminates.
                pass = true;
                break;
            }
        }
    }

    return mutated;
}

// Cluster one variant/important group's tokens per shorthand family, keyed by
// negative sign + value. Also records, per family, every value seen for each
// body, because the merge-safety pre-filter needs the values the value-keyed clusters
// deliberately keep apart.
//
// `getUtility` and `getSlot` let both the audit path (parseClassToken results)
// and the fix path (positional indices) share this one implementation, so the
// two can never cluster differently.
function clusterTokensByFamily(tokens, { getUtility, getSlot }) {
    const { bodyIndex } = getShorthandFamilies();
    const familyClusters = new Map();
    const familyBodyValues = new Map();
    const longestBodyPerToken = new Map();

    for (let i = 0; i < tokens.length; i += 1) {
        const utility = getUtility(tokens[i], i);
        for (const candidateBody of getUtilityBodyCandidates(utility)) {
            const matches = bodyIndex.get(candidateBody);
            if (!matches) {
                continue;
            }

            const matched = matchUtilityToBody(utility, candidateBody);
            if (!matched) {
                continue;
            }

            const clusterKey = `${matched.negative}|${matched.value}`;
            for (const { family, shorthand } of matches) {
                if (!familyClusters.has(family)) {
                    familyClusters.set(family, new Map());
                    familyBodyValues.set(family, new Map());
                    longestBodyPerToken.set(family, new Map());
                }

                // getUtilityBodyCandidates also yields every ancestor prefix, so
                // `gap-x-2` matches body `gap` with the nonsense value "x-2" as
                // well as body `gap-x` with the real value "2". Only the longest
                // matching body describes what the token actually is; recording
                // the ancestors too made every axis merge look like a conflict.
                const longestByToken = longestBodyPerToken.get(family);
                const previous = longestByToken.get(i);
                if (!previous || candidateBody.length > previous.body.length) {
                    longestByToken.set(i, { body: candidateBody, clusterKey });
                }

                const clusters = familyClusters.get(family);
                if (!clusters.has(clusterKey)) {
                    clusters.set(clusterKey, {
                        negative: matched.negative,
                        value: matched.value,
                        shorthands: new Map(),
                    });
                }

                const { shorthands } = clusters.get(clusterKey);
                if (!shorthands.has(shorthand)) {
                    shorthands.set(shorthand, getSlot(tokens[i], i));
                }
            }
        }
    }

    for (const [family, longestByToken] of longestBodyPerToken.entries()) {
        const bodyValues = familyBodyValues.get(family);
        for (const { body, clusterKey } of longestByToken.values()) {
            if (!bodyValues.has(body)) {
                bodyValues.set(body, new Set());
            }
            bodyValues.get(body).add(clusterKey);
        }
    }

    return { familyClusters, familyBodyValues };
}

// The merge rules the audit reports, in the order it checks them. Shared with
// the fix path (FIX_FAMILY_MERGE_RULES is this same list) so a rule can never
// exist on one side only.
const FAMILY_MERGE_RULES = [
    { sources: ["x", "y"], target: "all", corners: false },
    { sources: ["l", "r"], target: "x", corners: false },
    { sources: ["t", "b"], target: "y", corners: false },
    { sources: ["tl", "tr"], target: "t", corners: true },
    { sources: ["tr", "br"], target: "r", corners: true },
    { sources: ["bl", "br"], target: "b", corners: true },
    { sources: ["tl", "bl"], target: "l", corners: true },
    { sources: ["t", "r", "b", "l"], target: "all", corners: false },
];

function detectFamilyShorthand(groupedTokens, filePath, line, column, found, mergeSafety = null) {
    for (const tokens of groupedTokens.values()) {
        const { familyClusters, familyBodyValues } = clusterTokensByFamily(tokens, {
            getUtility: (token) => token.utility,
            getSlot: (token) => token,
        });
        const groupRaws = tokens.map((token) => token.raw);

        for (const [family, clusters] of familyClusters.entries()) {
            const bodyValues = familyBodyValues.get(family);

            for (const [clusterKey, cluster] of clusters.entries()) {
                const { negative, value, shorthands } = cluster;
                const get = (short) => shorthands.get(short) ?? null;
                const has = (short) => Boolean(get(short));

                const buildTarget = (short) => {
                    const body = family.shorthandToBody.get(short);
                    if (!body) {
                        return null;
                    }

                    const utility = `${negative}${body}${value ? `-${value}` : ""}`;
                    return formatClass(tokens[0].variants, tokens[0].important, utility);
                };

                for (const rule of FAMILY_MERGE_RULES) {
                    if (rule.corners && !family.supportsCorners) {
                        continue;
                    }
                    if (has(rule.target) || !rule.sources.every(has)) {
                        continue;
                    }

                    const target = buildTarget(rule.target);
                    if (!target) {
                        continue;
                    }

                    const sources = rule.sources.map(get);
                    const conflict = mergeHasValueConflict(
                        bodyValues,
                        family,
                        rule.sources,
                        rule.target,
                        clusterKey,
                    );
                    if (!mergeIsRenderSafe(
                        groupRaws,
                        sources.map((token) => token.raw),
                        target,
                        conflict,
                        mergeSafety,
                    )) {
                        continue;
                    }

                    emitSuggestion(found, filePath, line, column, sources, target);
                }
            }
        }
    }
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
    // arbitrary-value brackets/parens: `data-[state=open]:x` is a plain
    // class string. This mirrors looksLikeFixableClassString exactly: the
    // audit and fix paths must agree on what counts as a class string, or
    // "audit clean" stops implying "fix is a no-op".
    if (/[=><&|?*]/.test(stripBracketedSegments(value))) {
        return false;
    }

    return QUOTE_VALUE_SHAPE.test(value);
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
// scanning of every quoted string in the file (the pre-3.4 behavior) is
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
// Cheap pre-filter mirroring CLASS_STRING_FUNCTION_NAMES, so a file with no
// class attribute and no builder call skips parsing entirely.
const CLASS_BUILDER_HINT = /\b(?:clsx|cva|cx|cn|tv|twMerge|twJoin|classNames|classnames)\s*\(/;
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
// Class-string builders. Unlike the render functions above, EVERY string
// argument these receive is a class list, including strings nested in the
// variant objects of cva()/tv(). This is where a large share of modern
// Tailwind lives (shadcn/ui, class-variance-authority, tailwind-variants),
// and it used to be completely invisible to the scanner.
const CLASS_STRING_FUNCTION_NAMES = new Set([
    "classNames",
    "classnames",
    "clsx",
    "cn",
    "cva",
    "cx",
    "tv",
    "twJoin",
    "twMerge",
]);
// Depth cap for walking a cva()/tv() config object. Real configs nest three
// or four levels; the cap only stops a pathological input from recursing.
const MAX_CLASS_ARGUMENT_DEPTH = 8;

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
    const classStringSpans = [];
    const renderFunctionNames = new Set(RENDER_FUNCTION_NAMES);
    const classStringFunctionNames = new Set(CLASS_STRING_FUNCTION_NAMES);
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
            if (classStringFunctionNames.has(source) && !classStringFunctionNames.has(local)) {
                classStringFunctionNames.add(local);
                addedAlias = true;
            }
        }
    }

    // Record the inner bounds of every string that a class-string builder
    // receives, following the shapes those APIs actually use: bare strings,
    // arrays, ternaries, `cond && "..."`, and the nested objects of a cva()
    // variant map. Values that are not class lists (variant keys such as
    // "lg") are filtered later by shouldExtractQuotedClassValue.
    const collectClassStringArguments = (node, depth) => {
        if (depth > MAX_CLASS_ARGUMENT_DEPTH) {
            return;
        }
        const unwrapped = unwrapExpression(node);
        if (!unwrapped || typeof unwrapped !== "object") {
            return;
        }

        if (unwrapped.type === "StringLiteral" && Number.isInteger(unwrapped.start)) {
            classStringSpans.push({
                start: offset + unwrapped.start + 1,
                end: offset + unwrapped.end - 1,
            });
            return;
        }
        if (unwrapped.type === "TemplateLiteral") {
            // Only a template with no interpolation is a literal class list;
            // splitTemplateStaticChunks already handles the interpolated form
            // wherever a class attribute contains one.
            if (unwrapped.expressions.length === 0 && unwrapped.quasis.length === 1) {
                const quasi = unwrapped.quasis[0];
                classStringSpans.push({ start: offset + quasi.start, end: offset + quasi.end });
            }
            return;
        }
        if (unwrapped.type === "ArrayExpression") {
            for (const element of unwrapped.elements) {
                collectClassStringArguments(element, depth + 1);
            }
            return;
        }
        if (unwrapped.type === "ObjectExpression") {
            for (const property of unwrapped.properties) {
                if (property?.type === "ObjectProperty") {
                    collectClassStringArguments(property.value, depth + 1);
                }
            }
            return;
        }
        if (unwrapped.type === "ConditionalExpression") {
            collectClassStringArguments(unwrapped.consequent, depth + 1);
            collectClassStringArguments(unwrapped.alternate, depth + 1);
            return;
        }
        if (unwrapped.type === "LogicalExpression") {
            collectClassStringArguments(unwrapped.right, depth + 1);
        }
    };

    for (const call of callNodes) {
        const calleeName = getCalledFunctionName(call.callee);
        if (!calleeName || !classStringFunctionNames.has(calleeName)) {
            continue;
        }
        for (const argument of call.arguments) {
            collectClassStringArguments(argument, 0);
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

    return { allowedAttributeStarts, allowedObjectPropertyStarts, classStringSpans };
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




// `requireTemplate` is the Vue SFC rule: class attributes only count inside a
// <template>. Svelte, Astro and plain HTML have no such wrapper, so their
// markup is scanned at top level instead, with <script>/<style> bodies still
// skipped as raw regions.
function analyzeMarkupStructure(sourceText, { requireTemplate = true } = {}) {
    const allowedAttributeStarts = new Set();
    const scriptBlocks = [];
    let templateDepth = requireTemplate ? 0 : 1;
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
            if (requireTemplate && lowerName === "template" && templateDepth > 0) {
                templateDepth -= 1;
            }
            cursor = tag.end + 1;
            continue;
        }

        if (templateDepth > 0 && !(requireTemplate && lowerName === "template")) {
            for (const attribute of tag.attributes) {
                if (CLASS_ATTRIBUTE_NAMES.has(attribute.name)) {
                    allowedAttributeStarts.add(attribute.start);
                }
            }
        }

        if (requireTemplate && lowerName === "template" && !tag.selfClosing) {
            templateDepth += 1;
            cursor = tag.end + 1;
            continue;
        }

        if (lowerName === "script" || lowerName === "style") {
            const close = findRawElementClose(sourceText, lowerName, tag.end + 1);
            if (!close) {
                cursor = sourceText.length;
                continue;
            }
            if (lowerName === "script") {
                const langAttribute = tag.attributes.find(
                    (attribute) => attribute.name.toLowerCase() === "lang",
                );
                const typeAttribute = tag.attributes.find(
                    (attribute) => attribute.name.toLowerCase() === "type",
                );
                // Svelte/Astro spell it `lang="ts"`; plain HTML uses
                // type="module" or nothing at all.
                const lang = langAttribute?.value?.toLowerCase()
                    ?? (typeAttribute?.value?.toLowerCase() === "module" ? "js" : null)
                    ?? "js";
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
        if (requireTemplate && templateDepth === 0 && lowerName && !tag.selfClosing) {
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
    for (const span of source.classStringSpans ?? []) {
        target.classStringSpans.push(span);
    }
}

// The structural Babel/Vue analysis is the single most expensive step per
// file, and the fix path used to redo it for the very same text: once in
// collectBracketFixCandidates and again on the first applyFixesToText pass.
// Cache the last analysis per file path and reuse it whenever the text is
// byte-identical. Offsets shift as soon as a rewrite lands, so a changed pass
// still re-analyzes; this only removes the provably redundant repeats.
const SYNTAX_ANALYSIS_CACHE = new Map();
const MAX_SYNTAX_ANALYSIS_CACHE_ENTRIES = 64;

function analyzeClassSyntaxCached(sourceText, filePath) {
    const key = filePath ?? "";
    const cached = SYNTAX_ANALYSIS_CACHE.get(key);
    if (cached && cached.sourceText === sourceText) {
        return cached.analysis;
    }

    const analysis = analyzeClassSyntax(sourceText, filePath);
    if (SYNTAX_ANALYSIS_CACHE.size >= MAX_SYNTAX_ANALYSIS_CACHE_ENTRIES) {
        // Plain FIFO eviction; the access pattern is "same file several times
        // in a row", so recency beyond one entry per path buys nothing.
        SYNTAX_ANALYSIS_CACHE.delete(SYNTAX_ANALYSIS_CACHE.keys().next().value);
    }
    SYNTAX_ANALYSIS_CACHE.set(key, { sourceText, analysis });
    return analysis;
}

function analyzeClassSyntax(sourceText, filePath) {
    const analysis = {
        allowedAttributeStarts: new Set(),
        allowedObjectPropertyStarts: new Set(),
        classStringSpans: [],
    };
    const normalizedPath = String(filePath ?? "source.js").toLowerCase();
    const extension = path.extname(normalizedPath);

    if (MARKUP_EXTENSIONS.has(extension)) {
        // Astro frontmatter is a leading `---` fenced TypeScript block. It is
        // not markup, so hand it to the JS analyzer and scan only what follows
        // as markup.
        let markupSource = sourceText;
        let markupOffset = 0;
        if (extension === ".astro") {
            const frontmatter = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(sourceText);
            if (frontmatter) {
                markupOffset = frontmatter[0].length;
                markupSource = " ".repeat(markupOffset) + sourceText.slice(markupOffset);
            }
        }

        const markup = analyzeMarkupStructure(markupSource, {
            requireTemplate: extension === ".vue",
        });
        for (const start of markup.allowedAttributeStarts) {
            analysis.allowedAttributeStarts.add(start);
        }
        for (const block of markup.scriptBlocks) {
            const isTypeScript = ["ts", "tsx", "mts", "cts"].includes(block.lang);
            const isJavaScript = ["js", "jsx", "mjs", "cjs", "babel"].includes(block.lang);
            if (!isTypeScript && !isJavaScript) {
                continue;
            }
            let scriptAnalysis;
            try {
                scriptAnalysis = parseAndAnalyzeJavaScript(
                    block.source,
                    `${filePath ?? "source"}?script=${block.lang}`,
                    {
                        typescript: isTypeScript,
                        jsx: block.lang === "tsx" || block.lang === "jsx" || isJavaScript,
                        offset: block.offset,
                    },
                );
            } catch (error) {
                // Svelte and Astro scripts use framework-specific syntax
                // (`$:` labels are valid JS, but `{#if}` blocks in Astro's
                // frontmatter are not). A script we cannot parse means no
                // render-function props are recognized in it; the markup
                // attributes above are still perfectly usable, so degrade
                // rather than failing the whole file. Vue SFCs keep the strict
                // behavior because their script block is plain JS/TS.
                if (extension === ".vue") {
                    throw error;
                }
                continue;
            }
            mergeSyntaxAnalysis(analysis, scriptAnalysis);
        }
        return analysis;
    }

    const isTypeScript = extension === ".ts" || extension === ".tsx"
        || extension === ".mts" || extension === ".cts";
    return parseAndAnalyzeJavaScript(sourceText, filePath ?? "source.js", {
        typescript: isTypeScript,
        jsx: extension === ".jsx" || extension === ".tsx" || !isTypeScript,
    });
}


function extractClassLikeStrings(
    sourceText,
    { allowSingleTokenCanonical = false, filePath = null } = {},
) {
    // A class-string builder call (clsx/cva/tv/cn) does not have to contain the
    // substring "class", so the cheap bail-out has to look for those too.
    if (!sourceText.includes("class") && !CLASS_BUILDER_HINT.test(sourceText)) {
        return [];
    }
    const {
        allowedAttributeStarts,
        allowedObjectPropertyStarts,
        classStringSpans,
    } = analyzeClassSyntaxCached(sourceText, filePath);
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
        // start positionally, because indexOf would hit an earlier occurrence for
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

    for (const span of classStringSpans ?? []) {
        if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.end <= span.start) {
            continue;
        }
        const value = sourceText.slice(span.start, span.end);
        if (shouldExtractQuotedClassValue(value, { allowSingleTokenCanonical })) {
            push(value, span.start);
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
    return /\.(?:vue|svelte|astro|html|htm|js|mjs|cjs|ts|jsx|tsx|mts|cts)$/i.test(filePath);
}

function isMarkupFile(filePath) {
    return MARKUP_EXTENSIONS.has(path.extname(String(filePath ?? "")).toLowerCase());
}

function normalizeRelativePath(filePath) {
    return path.relative(process.cwd(), path.resolve(process.cwd(), filePath)).replace(/\\/g, "/");
}

const IGNORE_FILE_NAME = ".normwindignore";

// Extra ignore globs from --ignore and .normwindignore, compiled once.
let extraIgnoreMatchers = [];
let extraIgnoreGlobs = [];

function toIgnoreMatcher(pattern) {
    const trimmed = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!trimmed) {
        return null;
    }
    // A bare directory name means "everything under it", the way .gitignore
    // and every other ignore file people have used behaves.
    const expanded = hasGlobSyntax(trimmed)
        ? trimmed
        : `${trimmed.replace(/\/+$/, "")}/**`;
    return { glob: expanded, regex: globPatternToRegExp(expanded), bare: trimmed.replace(/\/+$/, "") };
}

async function loadIgnoreConfig(cliPatterns) {
    const patterns = [...cliPatterns];

    // The ignore FILE is checkout-controlled, so it is deliberately not read in
    // Action mode: a pull request could otherwise silence the audit on exactly
    // the files it changed. Explicit --ignore flags come from the workflow
    // author and are always honored.
    if (!ACTION_WORKSPACE_ROOT) {
        try {
            const raw = await fs.readFile(path.resolve(process.cwd(), IGNORE_FILE_NAME), "utf8");
            for (const line of raw.split(/\r?\n/)) {
                const value = line.trim();
                if (value && !value.startsWith("#")) {
                    patterns.push(value);
                }
            }
        } catch {
            // No ignore file is the normal case.
        }
    }

    extraIgnoreMatchers = patterns.map(toIgnoreMatcher).filter(Boolean);
    extraIgnoreGlobs = extraIgnoreMatchers.map((matcher) => `!${matcher.glob}`);
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
    if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
        return true;
    }

    for (const matcher of extraIgnoreMatchers) {
        if (matcher.regex.test(normalized) || normalized === matcher.bare) {
            return true;
        }
    }

    return false;
}

async function listFilesWithRipgrep(patterns) {
    if (process.env.NORMWIND_DISABLE_RIPGREP === "1") {
        const error = new Error("ripgrep is disabled in GitHub Action mode");
        error.code = "ENOENT";
        throw error;
    }
    const args = ["--files", "--hidden"];
    for (const glob of [...RG_IGNORE_GLOBS, ...extraIgnoreGlobs]) {
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
        // rg exit code 1 means "ran fine, nothing matched", which is a valid
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
            // ripgrep treats a backslash as an escape character, not a path
            // separator, while the fallback walker's globPatternToRegExp
            // normalized it. `normwind "src\**\*.vue"` therefore matched a
            // different set depending on whether rg happened to be installed.
            // Normalize once, here, so both consumers see the same string.
            globPatterns.push(pattern.replace(/\\/g, "/"));
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
                allowSingleTokenCanonical: isMarkupFile(filePath),
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
    // Tailwind if there are misses; a warm cache bypasses the ~1.4s
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
    //
    // Merge safety is resolved the same lazy way: the first sweep answers from
    // the memo and records every pair it could not answer. Only if something
    // was recorded is Tailwind loaded, the pending pairs resolved, and the
    // sweep replayed against a now-complete memo. A class list with no
    // conflicting sibling never reaches that path, so the warm-cache run still
    // never touches the design system.
    const runDetectionSweep = (mergeSafety) => runWithConcurrency(fileContexts, FILE_SCAN_CONCURRENCY, async (ctx) => {
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
                detectFamilyShorthand(
                    grouped,
                    relativePath,
                    snippetAnchor.line,
                    snippetAnchor.column,
                    localFound,
                    mergeSafety,
                );
                detectComplexEquivalences(
                    grouped,
                    relativePath,
                    snippetAnchor.line,
                    snippetAnchor.column,
                    localFound,
                    mergeSafety,
                );
            }
        }

        return [...localFound.values()];
    });

    let perFileFindings = [];
    for (let round = 0; round < MAX_MERGE_SAFETY_ROUNDS; round += 1) {
        const probe = createMergeSafetyProbe();
        perFileFindings = await runDetectionSweep(probe);
        if (!(await resolvePendingMergeChecks(probe.pending))) {
            break;
        }
    }

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
        `\nnormwinds: audit summary: ${skipped.length} skipped, ${failures.length} failed`,
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
        allowEmpty,
        checkCanonical,
        cleanupCanonicalFiles,
        dryRun,
        extractCanonical,
        fix,
        fixAll,
        help,
        ignorePatterns,
        invalidReporter,
        patterns,
        reporter,
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

    if (invalidReporter !== null) {
        console.error(
            `normwinds: unknown --reporter "${invalidReporter}". Supported: text, json, sarif.`,
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

    // The maintenance modes below return before any scanning happens, so
    // pairing them with scan-time flags used to drop those flags in silence.
    const maintenanceMode = checkCanonical || extractCanonical || cleanupCanonicalFiles;
    if (maintenanceMode && (fix || dryRun)) {
        console.error(
            "normwinds: --fix/--fixall/--dry-run cannot be combined with --check-canonical, --extract-canonical, or --cleanup-canonical-files.",
        );
        process.exitCode = 2;
        return;
    }
    if (dryRun && !fix) {
        console.error("normwinds: --dry-run only applies with --fix or --fixall.");
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

    // Fired now, unawaited, so the network round trip overlaps with the real
    // work below instead of adding latency of its own. Every return path past
    // this point awaits the result once, right before exit, so the ping still
    // gets its full window (see lib/ping.mjs for the timeout/throttle/opt-out
    // contract) without ever gating or slowing the audit itself.
    const pingPromise = sendInstallPing(NORMWINDS_VERSION);

    if (cleanupCanonicalFiles) {
        await cleanupCanonicalArtifacts();
        console.log(`normwinds v${NORMWINDS_VERSION}: removed canonical generated artifacts (if present).`);
        await pingPromise;
        return;
    }

    if (checkCanonical) {
        await extractCanonicalReplacements({ writeFiles: false, checkOnly: true });
        await pingPromise;
        return;
    }

    if (extractCanonical) {
        await extractCanonicalReplacements({ writeFiles: writeCanonicalFiles });
        await pingPromise;
        return;
    }

    await loadIgnoreConfig(ignorePatterns);

    const [filePaths] = await Promise.all([
        listTargetFiles(patterns),
        (async () => {
            await loadDiskCache();
            await loadCanonicalSnapshot();
        })(),
    ]);

    if (patterns.length > 0 && filePaths.length === 0) {
        // Exit 2, not 0. A typo'd path in a CI step used to be indistinguishable
        // from a clean audit, so the job went green having scanned nothing.
        console.error(
            `normwinds: the given pattern(s) matched no lintable files: ${patterns.join(", ")}`,
        );
        console.error(
            "Check the path, or pass --allow-empty if matching nothing is expected.",
        );
        if (!allowEmpty) {
            process.exitCode = 2;
            await pingPromise;
            return;
        }
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

    if (reporter === "sarif") {
        console.log(JSON.stringify(buildSarifReport(findings, lintedFiles, {
            version: NORMWINDS_VERSION,
            ruleId: RULE_ID,
        }), null, 2));
    } else if (reporter === "json") {
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
    await pingPromise;
}

main().catch((error) => {
    console.error("normwinds: failed to run shorthand audit.");
    console.error(error);
    process.exitCode = 2;
});
