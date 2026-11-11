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
import {
    createTailwindDesignSystem,
    getProjectThemeCssHash,
    loadTailwind,
    loadTailwindDesignSystem,
} from "./design-system.mjs";
import {
    ACTION_MAX_LIVE_CANONICALIZATIONS,
    LIVE_CANONICALIZATIONS_PER_ENGINE,
} from "./scan-config.mjs";
import {
    ACTION_WORKSPACE_ROOT,
    BUNDLED_CANONICAL_JSON,
    NORMWINDS_VERSION,
    PACKAGE_ROOT,
    toPortableModulePath,
} from "./workspace.mjs";

const NODE_MODULES_DIR = path.resolve(process.cwd(), "node_modules");
const CACHE_FILE = path.join(NODE_MODULES_DIR, ".cache/normwinds/canonical-cache.json");
// Schema 2: merge-safety verdicts fail closed on classes the design system does
// not know, so every schema-1 "safe" verdict is suspect and must not survive.
const CACHE_SCHEMA_VERSION = 2;
const MAX_CACHE_FILE_BYTES = 8 * 1024 * 1024;

// CANONICAL_MEMO stores token -> canonical (equal to token = no change).
// Pre-populated from on-disk cache; any new entries are persisted on exit.
const CANONICAL_MEMO = new Map();
// Only dynamically-computed entries belong in the writable cache. Snapshot
// entries are already shipped with the package; persisting all 12k+ of them
// again needlessly bloats every consumer project's cache.
const DYNAMIC_CACHE_KEYS = new Set();
let diskCacheDirty = false;

// A cached answer is only valid for the exact rules and engine that produced
// it: the NormWind version (a release can change a merge rule or the safety
// check behind a `mergesafe:`/`collapse:` verdict), the Tailwind version, and
// the project theme the design system was built from (--theme-css).
function currentCacheIdentity() {
    const { tailwindPkg } = loadTailwind();
    return {
        schema: CACHE_SCHEMA_VERSION,
        normwindVersion: NORMWINDS_VERSION,
        tailwindVersion: tailwindPkg.version,
        themeCssHash: getProjectThemeCssHash(),
    };
}

function cacheIdentityMatches(parsed, identity) {
    return Boolean(parsed)
        && parsed.schema === identity.schema
        && parsed.normwindVersion === identity.normwindVersion
        && parsed.tailwindVersion === identity.tailwindVersion
        && (parsed.themeCssHash ?? null) === identity.themeCssHash;
}

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
        if (
            cacheIdentityMatches(parsed, currentCacheIdentity()) &&
            parsed.entries &&
            typeof parsed.entries === "object"
        ) {
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
        // Replace stale or malformed caches on the next successful run. The
        // identity is checked before any entry enters CANONICAL_MEMO, so a
        // fully warm, stale cache can never bypass invalidation.
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
        // The cache lives in the project's own node_modules. A project that
        // has none (a plain HTML site, an npx run in a docs folder) gets no
        // cache rather than a node_modules/ folder it never asked for.
        const nodeModules = await fs.stat(NODE_MODULES_DIR).catch(() => null);
        if (!nodeModules?.isDirectory()) {
            return;
        }
        await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
        const entries = Object.create(null);
        for (const key of DYNAMIC_CACHE_KEYS) {
            const value = CANONICAL_MEMO.get(key);
            if (isSafeCacheEntry(key, value)) {
                entries[key] = value;
            }
        }
        const payload = { ...currentCacheIdentity(), entries };
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
    // Every snapshot answer was computed against Tailwind's default theme.
    // With --theme-css the project's own theme judges the run, so a shipped
    // `rounded-[8px] -> rounded-lg` could be wrong here; answer live instead.
    if (getProjectThemeCssHash()) {
        return false;
    }

    // Only the snapshot shipped inside the package is read. A scanned
    // repository that carried its own docs/reference/canonical-replacements.json
    // used to be trusted first outside Action mode, which let the repository
    // choose what --fix writes; values are only shape-checked. Inside a NormWind
    // checkout the two paths are the same file, so maintenance is unaffected.
    const paths = [BUNDLED_CANONICAL_JSON];
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

// Live canonicalization. Tailwind retains about 0.4 MB of heap per unique
// candidate one engine has canonicalized (measured 2026-11-11 on 4.3.3: +420 MB
// at 1,000, +2.3 GB at 6,000, out of memory before 12,000). Each engine
// therefore answers at most LIVE_CANONICALIZATIONS_PER_ENGINE candidates and
// is then replaced by a fresh one, which holds the heap near 600 MB however
// many there are. A large codebase is worked through in batches instead of
// refused; only Action mode, whose input is an untrusted pull request, keeps a
// hard ceiling so a hostile change cannot run the job to its timeout.
let liveEngine = null;
let liveCanonicalizationCount = 0;
let canonicalizerSupportWarned = false;

async function nextLiveEngine() {
    if (liveEngine && liveEngine.used < LIVE_CANONICALIZATIONS_PER_ENGINE) {
        return liveEngine;
    }
    // The first engine is the shared one (merge safety and collapse reuse it);
    // every later batch gets its own, so the previous one can be collected.
    const { designSystem } = liveEngine ? await createTailwindDesignSystem() : await loadTailwindDesignSystem();
    if (typeof designSystem.canonicalizeCandidates !== "function" && !canonicalizerSupportWarned) {
        // --extract-canonical throws for exactly this condition; the scan path
        // degrades instead, but silently degrading a whole class of fixes with
        // no signal is worse than a warning.
        canonicalizerSupportWarned = true;
        const { tailwindPkg, source } = loadTailwind();
        console.error(
            `normwinds: the resolved Tailwind (${source} v${tailwindPkg.version}) does not expose canonicalizeCandidates; arbitrary-value canonicalization is disabled for this run.`,
        );
    }
    liveEngine = { designSystem, used: 0 };
    return liveEngine;
}

function canonicalizeWithEngine(engine, candidate) {
    const { designSystem } = engine;
    const canonical = typeof designSystem.canonicalizeCandidates === "function"
        ? designSystem.canonicalizeCandidates([candidate], {
            rem: ROOT_FONT_SIZE_PX,
        })?.[0]
        : candidate;
    engine.used += 1;
    liveCanonicalizationCount += 1;
    const result = (!canonical || /\s/.test(canonical)) ? candidate : canonical;
    CANONICAL_MEMO.set(candidate, result);
    DYNAMIC_CACHE_KEYS.add(candidate);
    diskCacheDirty = true;
    return result;
}

// Put every candidate's canonical form in the memo, in engine-sized batches.
// After it resolves, a memo lookup answers each of them without Tailwind.
async function warmCanonicalMemo(candidates) {
    const misses = [];
    for (const candidate of new Set(candidates)) {
        if (typeof candidate === "string" && candidate && !CANONICAL_MEMO.has(candidate)) {
            misses.push(candidate);
        }
    }
    if (misses.length === 0) {
        return;
    }
    if (ACTION_WORKSPACE_ROOT && liveCanonicalizationCount + misses.length > ACTION_MAX_LIVE_CANONICALIZATIONS) {
        throw new Error(
            `normwinds: refusing to live-canonicalize ${liveCanonicalizationCount + misses.length} unique arbitrary-value classes in one Action run (limit: ${ACTION_MAX_LIVE_CANONICALIZATIONS}). Narrow the scan with the patterns or ignore inputs.`,
        );
    }
    for (const candidate of misses) {
        canonicalizeWithEngine(await nextLiveEngine(), candidate);
    }
}

let canonicalizerFnPromise = null;
async function getCanonicalizeCandidate() {
    if (!canonicalizerFnPromise) {
        canonicalizerFnPromise = (async () => {
            // Loading Tailwind is the expensive bit (~1.4s to prime the
            // design system); callers skip it if everything is in-cache.
            await nextLiveEngine();
            return (candidate) => {
                if (!candidate || typeof candidate !== "string") {
                    return candidate;
                }
                const cached = CANONICAL_MEMO.get(candidate);
                if (cached !== undefined) {
                    return cached;
                }
                // Callers warm the memo first; this only serves the rare token
                // a rewrite produced after warming, on the current engine.
                return canonicalizeWithEngine(liveEngine, candidate);
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
    warmCanonicalMemo,
};
