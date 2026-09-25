// Tailwind's own utility collapse, asked before the vendored group table.
//
// WHY: the family table behind lib/shorthand-families.mjs is a v3-era snapshot
// of eslint-plugin-tailwindcss's group data and only knows the merges someone
// wrote down. Tailwind 4.x answers the same question itself:
// designSystem.canonicalizeCandidates(list, { collapse: true }) replaces a set
// of utilities with one whose compiled CSS signature equals the set's, so it
// covers every utility the loaded engine knows (including the text-size/leading
// pairs the table never had) and moves forward with each Tailwind release. The
// table stays as the fallback for engines without the option, for runs that
// cannot load Tailwind, and for any group the engine has not answered yet.
//
// Answers are memoized in CANONICAL_MEMO under a key prefix, next to the
// canonicalization and merge-safety verdicts, so they persist in the disk cache
// and are invalidated by the same Tailwind version check.

import process from "node:process";
import {
    CANONICAL_MEMO,
    rememberDynamicCacheEntry,
    validateCacheAgainstTailwindVersion,
} from "./canonical-cache.mjs";
import { ROOT_FONT_SIZE_PX } from "./constants.mjs";
import { loadTailwindDesignSystem } from "./design-system.mjs";

const COLLAPSE_CACHE_PREFIX = "collapse:";
const MAX_COLLAPSE_KEY_LENGTH = 4096;
// A class list is untrusted input in Action mode; an outsized group goes to the
// table (linear in its size) instead of the engine's per-group signature work.
const MAX_COLLAPSE_GROUP_SIZE = 32;
// Memo values: an encoded merge list, or one of these two sentinels.
const NO_MERGES = "_";
const ENGINE_CANNOT_COLLAPSE = "~";
// Upper bound on the removed utilities searched when the engine produced more
// than one replacement and each has to be tied back to its own sources. 2^8
// subset probes per replacement is cheap; a larger pool is left to the table.
const MAX_ATTRIBUTION_POOL = 8;
// WHY: every distinct group is a dynamic disk-cache key, and loadDiskCache
// discards the whole file past its size limit, so a large monorepo could keep
// itself permanently cold. Past this many collapse answers, new groups are no
// longer sent to the engine and the table answers them instead.
const MAX_COLLAPSE_ENTRIES = 20000;
let collapseEntryCount = null;
let collapseBudgetSpent = false;

function countCollapseEntries() {
    if (collapseEntryCount === null) {
        collapseEntryCount = 0;
        for (const key of CANONICAL_MEMO.keys()) {
            if (key.startsWith(COLLAPSE_CACHE_PREFIX)) {
                collapseEntryCount += 1;
            }
        }
    }
    return collapseEntryCount;
}

function rememberCollapse(key, value) {
    if (countCollapseEntries() >= MAX_COLLAPSE_ENTRIES) {
        collapseBudgetSpent = true;
        return false;
    }
    rememberDynamicCacheEntry(key, value);
    collapseEntryCount += 1;
    return true;
}
// Replacements the composite pass in lib/shorthand.mjs already owns (w/h to
// size, truncate, place-*). Reporting them here as well would double every
// such finding under a second message.
const COMPOSITE_OWNED_TARGET = /^(?:truncate$|size-|place-(?:content|items|self)-)/;
// logicalToPhysical lets the engine equate `mx-2` (margin-inline) with
// `ml-2 mr-2`, the same left-to-right reading lib/css.mjs gives the merge
// proof and the table has always made. It would also equate a start/end
// utility with one physical side, which flips under dir="rtl", so a merge
// that touches a start/end property on either side is dropped.
const DIRECTIONAL_PROPERTY = /[\w-]*(?:inline|block|start|end)-(?:start|end)[\w-]*\s*:/;
// A set every collapse-capable engine folds into one utility. An engine that
// silently ignores the option returns it unchanged.
const COLLAPSE_FEATURE_PROBE = ["mt-2", "mr-2", "mb-2", "ml-2"];

function engineCollapseDisabled() {
    return process.env.NORMWIND_DISABLE_ENGINE_COLLAPSE === "1";
}

// Cache keys and values must survive isSafeCacheEntry (no whitespace, no
// quotes), and the value format reserves `,` `=` `+` `;`. encodeURIComponent
// escapes all of those except the apostrophe, which arbitrary content values
// such as content-['x'] can carry.
function encodeUtility(utility) {
    return encodeURIComponent(utility).replace(/'/g, "%27");
}

function buildCollapseKey(utilities) {
    return `${COLLAPSE_CACHE_PREFIX}${[...new Set(utilities)].sort().map(encodeUtility).join(",")}`;
}

function encodeMerges(merges) {
    if (merges.length === 0) {
        return NO_MERGES;
    }
    return merges
        .map(({ target, sources }) => `${encodeUtility(target)}=${sources.map(encodeUtility).join("+")}`)
        .join(";");
}

function decodeMerges(value) {
    if (value === ENGINE_CANNOT_COLLAPSE) {
        return null;
    }
    if (value === NO_MERGES) {
        return [];
    }
    // A hand-edited or truncated disk-cache value reads as "no answer" (the
    // table) rather than throwing mid-scan.
    try {
        return value.split(";").map((part) => {
            const [target, sources, extra] = part.split("=");
            if (!target || !sources || extra !== undefined) {
                throw new Error("malformed collapse cache entry");
            }
            return {
                target: decodeURIComponent(target),
                sources: sources.split("+").map((source) => decodeURIComponent(source)),
            };
        });
    } catch {
        return null;
    }
}

// The engine's answer for one variant/important group of bare utilities, as a
// list of { target, sources } merges ([] = nothing to collapse). null means the
// engine has no answer (disabled, unsupported, or not resolved yet) and the
// caller must use the vendored table. An unresolved group is recorded on the
// probe, when there is one, for resolvePendingCollapses to answer in batch.
function lookupEngineCollapse(utilities, probe = null) {
    if (engineCollapseDisabled()) {
        return null;
    }
    const unique = [...new Set(utilities)];
    if (unique.length < 2 || unique.length > MAX_COLLAPSE_GROUP_SIZE) {
        return null;
    }
    const key = buildCollapseKey(unique);
    if (key.length > MAX_COLLAPSE_KEY_LENGTH) {
        return null;
    }
    const cached = CANONICAL_MEMO.get(key);
    if (cached !== undefined) {
        return decodeMerges(cached);
    }
    if (!collapseBudgetSpent && Array.isArray(probe?.pendingCollapses) && !probe.pendingCollapseKeys.has(key)) {
        probe.pendingCollapseKeys.add(key);
        probe.pendingCollapses.push(unique);
    }
    return null;
}

const collapseSupport = new WeakMap();
function engineSupportsCollapse(designSystem) {
    if (!collapseSupport.has(designSystem)) {
        let supported = false;
        if (typeof designSystem.canonicalizeCandidates === "function") {
            try {
                const collapsed = designSystem.canonicalizeCandidates(COLLAPSE_FEATURE_PROBE, {
                    collapse: true,
                    rem: ROOT_FONT_SIZE_PX,
                });
                supported = Array.isArray(collapsed) && collapsed.length < COLLAPSE_FEATURE_PROBE.length;
            } catch {
                supported = false;
            }
        }
        collapseSupport.set(designSystem, supported);
    }
    return collapseSupport.get(designSystem);
}

function* combinations(pool, size, start = 0, picked = []) {
    if (picked.length === size) {
        yield [...picked];
        return;
    }
    for (let i = start; i <= pool.length - (size - picked.length); i += 1) {
        picked.push(pool[i]);
        yield* combinations(pool, size, i + 1, picked);
        picked.pop();
    }
}

// Tie one replacement back to the utilities it replaced: the smallest subset of
// the removed pool (at least two, so a single-token rename is never passed off
// as a merge) that the engine collapses to exactly that one utility.
function attributeSources(collapse, target, pool) {
    if (pool.length < 2) {
        return null;
    }
    const collapsesToTarget = (subset) => {
        const collapsed = collapse(subset);
        return collapsed?.length === 1 && collapsed[0] === target;
    };
    if (collapsesToTarget(pool)) {
        return pool;
    }
    if (pool.length > MAX_ATTRIBUTION_POOL) {
        return null;
    }
    for (let size = 2; size < pool.length; size += 1) {
        for (const subset of combinations(pool, size)) {
            if (collapsesToTarget(subset)) {
                return subset;
            }
        }
    }
    return null;
}

function computeCollapseMerges(designSystem, utilities) {
    const collapse = (list) => {
        try {
            const collapsed = designSystem.canonicalizeCandidates(list, {
                collapse: true,
                logicalToPhysical: true,
                rem: ROOT_FONT_SIZE_PX,
            });
            return Array.isArray(collapsed) ? collapsed : null;
        } catch {
            return null;
        }
    };
    const cssOf = (utility) => {
        try {
            return designSystem.candidatesToCss([utility])?.[0] || null;
        } catch {
            return null;
        }
    };
    // Only utilities the engine compiles may take part: an unknown class the
    // engine drops from its output must never be read as merged away.
    const known = utilities.filter((utility) => cssOf(utility) !== null);
    if (known.length < 2) {
        return { merges: [], output: null };
    }
    const collapsed = collapse(known);
    if (!collapsed) {
        return { merges: [], output: null };
    }

    const input = new Set(known);
    const output = new Set(collapsed);
    let pool = known.filter((utility) => !output.has(utility));
    const merges = [];
    // A replacement that cannot be tied to its sources, or is dropped as
    // direction-dependent, leaves the engine's answer only partly usable; the
    // group then goes to the table rather than losing what the table finds.
    let unexplained = false;
    for (const target of output) {
        if (input.has(target)) {
            continue;
        }
        const sources = /\s/.test(target) ? null : attributeSources(collapse, target, pool);
        if (!sources) {
            unexplained = true;
            continue;
        }
        // A composite-owned replacement is not reported here, but its sources
        // are accounted for, so they do not count as unexplained below.
        pool = pool.filter((utility) => !sources.includes(utility));
        if (COMPOSITE_OWNED_TARGET.test(target)) {
            continue;
        }
        if ([target, ...sources].some((utility) => DIRECTIONAL_PROPERTY.test(cssOf(utility) ?? ""))) {
            unexplained = true;
            continue;
        }
        merges.push({ target, sources });
    }
    // WHY: a utility the engine removed that no replacement accounts for (a
    // redundant one it dropped, say) means the merges are not the engine's
    // whole answer, so the group must not be cached as authoritative.
    if (unexplained || pool.length > 0) {
        return { merges: null, output: null };
    }
    // Classes the engine does not know pass through untouched, so they belong
    // to the settled form of the whole group too.
    for (const utility of utilities) {
        if (!input.has(utility)) {
            output.add(utility);
        }
    }
    return { merges, output };
}

// The fixer applies every merge of a group at once and then looks the
// rewritten group up again. When the merges account for the engine's whole
// answer, that rewritten group is the engine's own output, which a canonical
// form leaves unchanged, so record it as settled rather than spending another
// resolve round (and a table fallback in between) on it.
function recordCollapsedOutput(utilities, merges, output) {
    if (!output || merges.length === 0) {
        return;
    }
    const after = new Set(utilities);
    for (const { target, sources } of merges) {
        for (const source of sources) {
            after.delete(source);
        }
        after.add(target);
    }
    if (after.size !== output.size || [...after].some((utility) => !output.has(utility))) {
        return;
    }
    const key = buildCollapseKey([...after]);
    if (key.length <= MAX_COLLAPSE_KEY_LENGTH && !CANONICAL_MEMO.has(key)) {
        rememberCollapse(key, NO_MERGES);
    }
}

let loadFailureReported = false;

// Answer every group a probe recorded with one design-system load. Returns true
// when the memo gained answers, so the caller replays its sweep against them.
async function resolvePendingCollapses(pending) {
    if (!pending || pending.length === 0) {
        return false;
    }
    let designSystem;
    try {
        validateCacheAgainstTailwindVersion();
        ({ designSystem } = await loadTailwindDesignSystem());
    } catch (error) {
        if (!loadFailureReported) {
            loadFailureReported = true;
            console.error(
                `normwinds: could not load Tailwind to collapse utility groups; the vendored group table was used instead (${error?.message || String(error)})`,
            );
        }
        return false;
    }

    // Recount per batch: the version check above may have emptied the memo.
    collapseEntryCount = null;
    const supported = engineSupportsCollapse(designSystem);
    let gained = false;
    for (const utilities of pending) {
        const key = buildCollapseKey(utilities);
        if (CANONICAL_MEMO.has(key)) {
            continue;
        }
        if (collapseBudgetSpent) {
            break;
        }
        if (!supported) {
            gained = rememberCollapse(key, ENGINE_CANNOT_COLLAPSE) || gained;
            continue;
        }
        const { merges, output } = computeCollapseMerges(designSystem, utilities);
        if (!merges) {
            gained = rememberCollapse(key, ENGINE_CANNOT_COLLAPSE) || gained;
            continue;
        }
        if (rememberCollapse(key, encodeMerges(merges))) {
            gained = true;
            recordCollapsedOutput(utilities, merges, output);
        }
    }
    return gained;
}

export {
    computeCollapseMerges,
    engineSupportsCollapse,
    lookupEngineCollapse,
    resolvePendingCollapses,
};
