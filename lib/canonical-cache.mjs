// The canonicalization memo and its two persistent backings.
//
// One Map answers "what is the canonical form of this token", filled from a
// shipped snapshot (read-only, valid only for the Tailwind version, CSS entry
// and rem base that produced it) and from a writable per-project disk cache.
// The theme-var resolver and the merge-safety checker park their verdicts here
// too, under key prefixes, so one version change invalidates all three at once.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ROOT_FONT_SIZE_PX } from "./constants.mjs";
import { loadTailwind, loadTailwindDesignSystem } from "./design-system.mjs";
import {
    ACTION_WORKSPACE_ROOT,
    BUNDLED_CANONICAL_JSON,
    CANONICAL_OUTPUT_JSON,
    PACKAGE_ROOT,
    toPortableModulePath,
} from "./workspace.mjs";

const CACHE_FILE = path.resolve(process.cwd(), "node_modules/.cache/normwinds/canonical-cache.json");
const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_FILE_BYTES = 8 * 1024 * 1024;

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

            if (!canonicalSnapshotMatchesExpectations(parsed, tailwindPkg, expectedIndexCssPath)) {
                continue;
            }

            applyCanonicalSnapshotReplacements(parsed.replacements);
            return true;
        } catch {
            // Try the next snapshot source.
        }
    }

    return false;
}

// A snapshot is usable only if it was produced by the same Tailwind version,
// the same CSS entry point, and the same rem base as this run -- otherwise
// its canonicalization results don't apply here.
function canonicalSnapshotMatchesExpectations(parsed, tailwindPkg, expectedIndexCssPath) {
    if (
        !parsed ||
        parsed.source?.tailwindVersion !== tailwindPkg.version ||
        !Array.isArray(parsed.replacements)
    ) {
        return false;
    }
    if (
        expectedIndexCssPath &&
        typeof parsed.source?.tailwindIndexCssPath === "string" &&
        parsed.source.tailwindIndexCssPath !== expectedIndexCssPath
    ) {
        return false;
    }
    if (
        parsed.source?.rootFontSizePx !== undefined &&
        parsed.source.rootFontSizePx !== ROOT_FONT_SIZE_PX
    ) {
        return false;
    }
    return true;
}

function applyCanonicalSnapshotReplacements(replacements) {
    for (const replacement of replacements) {
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

// Record a dynamically-computed memo entry and mark the disk cache for rewrite.
// The three steps always travel together, and the two other writers live in
// other modules, so the trio is exported as one named operation rather than as
// a writable dirty flag.
function rememberDynamicCacheEntry(key, value) {
    CANONICAL_MEMO.set(key, value);
    DYNAMIC_CACHE_KEYS.add(key);
    diskCacheDirty = true;
}

// The scan's second pass reuses the canonicalizer only if the first pass
// already started it. A null here means every token was cache-warm, and
// Tailwind must not be loaded just to look them up a second time.
function peekCanonicalizerPromise() {
    return canonicalizerFnPromise;
}

export {
    CANONICAL_MEMO,
    getCanonicalizeCandidate,
    loadCanonicalSnapshot,
    loadDiskCache,
    lookupCanonicalFromMemo,
    peekCanonicalizerPromise,
    rememberDynamicCacheEntry,
    saveDiskCache,
    validateCacheAgainstTailwindVersion,
};
