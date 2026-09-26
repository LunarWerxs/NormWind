// Proving that a shorthand merge cannot change the rendered CSS.

import { winningDeclarations } from "./css.mjs";
import {
    CANONICAL_MEMO,
    rememberDynamicCacheEntry,
    validateCacheAgainstTailwindVersion,
} from "./canonical-cache.mjs";
import { loadTailwindDesignSystem } from "./design-system.mjs";
import { resolvePendingCollapses } from "./engine-collapse.mjs";

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
// Whether two winning-declaration maps describe the same computed CSS:
// same property count and every property resolving to the same value.
function declarationSetsEqual(beforeDeclarations, afterDeclarations) {
    if (
        !beforeDeclarations ||
        !afterDeclarations ||
        beforeDeclarations.size !== afterDeclarations.size
    ) {
        return false;
    }
    for (const [property, value] of beforeDeclarations) {
        if (afterDeclarations.get(property) !== value) {
            return false;
        }
    }
    return true;
}

function buildMergeSafetyChecker(designSystem) {
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
        const safe = declarationSetsEqual(beforeDeclarations, afterDeclarations);

        rememberDynamicCacheEntry(key, safe ? "1" : "0");
        return safe;
    };
}

async function loadMergeSafetyChecker() {
    validateCacheAgainstTailwindVersion();
    const { designSystem } = await loadTailwindDesignSystem();
    if (
        typeof designSystem.getClassOrder !== "function" ||
        typeof designSystem.candidatesToCss !== "function"
    ) {
        return null;
    }
    return buildMergeSafetyChecker(designSystem);
}

async function getMergeSafetyChecker() {
    if (!mergeSafetyPromise) {
        mergeSafetyPromise = loadMergeSafetyChecker();
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
// Used by both the audit sweep and the fix pass; a run whose merge checks and
// utility-group collapses are all in the memo (a warm disk cache) records
// nothing and never loads Tailwind at all.
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
    // The same probe carries the utility groups Tailwind's collapse has not
    // answered yet (see lib/engine-collapse.mjs), so one resolve step and one
    // replay serve both questions.
    probe.pendingCollapses = [];
    probe.pendingCollapseKeys = new Set();
    return probe;
}

// Resolve everything a probe recorded: merge-safety pairs and pending utility
// groups for the engine collapse. Returns true when the memo gained answers,
// so the caller can replay against it.
async function resolvePendingMergeChecks(pending, pendingCollapses = []) {
    const collapsesResolved = await resolvePendingCollapses(pendingCollapses);
    if (pending.length === 0) {
        return collapsesResolved;
    }
    const mergeSafety = await getMergeSafetyChecker().catch((error) => {
        console.error(
            `normwinds: could not load Tailwind to verify shorthand merge safety; affected suggestions were skipped (${error?.message || String(error)})`,
        );
        return null;
    });
    if (!mergeSafety) {
        return collapsesResolved;
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
    const verdict = mergeSafety(groupRaws, replaceMergedRaws(groupRaws, sourceRaws, targetRaw));
    return verdict === true;
}

// The group's raw tokens after a merge: the target takes the first source's
// place and the other sources drop out. Exported so a caller planning several
// merges in a row can judge each one against the group the previous left.
function replaceMergedRaws(groupRaws, sourceRaws, targetRaw) {
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
    return after;
}

export {
    MAX_MERGE_SAFETY_ROUNDS,
    createMergeSafetyProbe,
    mergeHasValueConflict,
    mergeIsRenderSafe,
    replaceMergedRaws,
    resolvePendingMergeChecks,
};
