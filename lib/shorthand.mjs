// The shorthand engine: what may be merged, and the merge itself.
//
// Audit and fix are two readings of one rule set -- family shorthands
// (`ml-2 mr-2` into `mx-2`), the width/height into `size` special case, and the
// composite equivalences (`place-*`, `inset-*`). Detection reports them and the
// merge functions perform them; they share the clustering and the conflict
// tests rather than keeping two copies that can drift apart.

import path from "node:path";
import process from "node:process";
import {
    buildFixToken,
    formatClass,
    getUtilityBodyCandidates,
    matchFixBodyValue,
    matchUtilityToBody,
    parseFixToken,
} from "./tokens.mjs";
import { lookupEngineCollapse } from "./engine-collapse.mjs";
import { mergeHasValueConflict, mergeIsRenderSafe, replaceMergedRaws } from "./merge-safety.mjs";
import { COMPLEX_EQUIVALENCES, getShorthandFamilies } from "./shorthand-families.mjs";

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

// The vendored table families each entry of one group belongs to (`ml-2` is in
// the margin family, `rounded-tl-md` in the radius family), keyed by entry.
function tableFamiliesByEntry(entries) {
    const { familyClusters } = clusterTokensByFamily(entries, {
        getUtility: (entry) => entry.utility,
        getSlot: (entry) => entry,
    });
    const byEntry = new Map();
    for (const [family, clusters] of familyClusters.entries()) {
        for (const { shorthands } of clusters.values()) {
            for (const entry of shorthands.values()) {
                if (!byEntry.has(entry)) {
                    byEntry.set(entry, new Set());
                }
                byEntry.get(entry).add(family);
            }
        }
    }
    return byEntry;
}

// WHY additive only: when the engine's answer replaced the table for a group,
// findings the engine does not make were lost (`rounded-t-xl ... rounded-l-xl`
// -> `rounded-xl`, `border-l border-r` -> `border-x`). So an engine merge is
// kept only if it touches no raw in `claimedRaws` (the table's findings) and
// its sources do not all sit in one table family, whose rules stay the table's
// call (the radius family has no t+b -> all step).
//
// The render-safety proof covers the rest of the class list, which the engine
// never saw (a sibling `mx-8` starts winning after `ml-2 mr-2` -> `mx-2`).
function planEngineCollapse(entries, makeTarget, mergeSafety, claimedRaws = new Set()) {
    const merges = lookupEngineCollapse(entries.map((entry) => entry.utility), mergeSafety);
    if (!merges || merges.length === 0) {
        return [];
    }
    const familiesByEntry = tableFamiliesByEntry(entries);
    const tableOwns = (sourceEntries) => {
        const [first, ...rest] = sourceEntries.map((entry) => familiesByEntry.get(entry) ?? new Set());
        return [...first].some((family) => rest.every((families) => families.has(family)));
    };
    let groupRaws = entries.map((entry) => entry.raw);
    const planned = [];
    for (const { target, sources } of merges) {
        const sourceEntries = sources.map((utility) => entries.find((entry) => entry.utility === utility));
        if (sourceEntries.some((entry) => !entry || claimedRaws.has(entry.raw)) || tableOwns(sourceEntries)) {
            continue;
        }
        const sourceRaws = sourceEntries.map((entry) => entry.raw);
        const targetRaw = makeTarget(target);
        const consumed = new Set(sourceRaws);
        const hasSibling = groupRaws.some((raw) => !consumed.has(raw));
        if (!mergeIsRenderSafe(groupRaws, sourceRaws, targetRaw, hasSibling, mergeSafety)) {
            continue;
        }
        planned.push({ sourceEntries, target, targetRaw });
        groupRaws = replaceMergedRaws(groupRaws, sourceRaws, targetRaw);
    }
    return planned;
}

// Fix-side view of planEngineCollapse: the same plan, as token indices. The
// fixer asks only once the table has no merge left in the group, so nothing is
// claimed.
function planEngineGroupMerges(groupIndices, tokens, parsed, mergeSafety) {
    const base = parsed[groupIndices[0]];
    const planned = planEngineCollapse(
        groupIndices.map((index) => ({ raw: tokens[index], utility: parsed[index].utility, index })),
        (utility) => buildFixToken({ variants: base.variants, utility, important: base.important }),
        mergeSafety,
    );
    return planned.map(({ sourceEntries, target }) => ({
        indices: sourceEntries.map((entry) => entry.index).sort((a, b) => a - b),
        targetUtility: target,
    }));
}












// Locate the first family merge the audit would report for the current token
// list. Tokens are grouped by variant prefix + important flag and then handed
// to the SAME clusterTokensByFamily the audit uses, so the two paths can never
// disagree about which merges exist.
// Try one FAMILY_MERGE_RULES rule against one (family, cluster) pair. Pulled
// out of findFamilyMerge's quadruple-nested loop so the outer function only
// has to reason about iteration, not rule mechanics.
function tryFamilyMergeRule(rule, { family, clusterKey, cluster, bodyValues, groupRaws, tokens, parsed, mergeSafety }) {
    if (rule.corners && !family.supportsCorners) {
        return null;
    }
    const targetBody = family.shorthandToBody.get(rule.target);
    if (!targetBody) {
        return null;
    }
    const { negative, value, shorthands } = cluster;
    // Parity with detectFamilyShorthand: when the target shorthand is
    // already present the audit stays silent, so the fixer must not rewrite
    // either. Without this the fixer collapsed `p-4 px-4 py-4` to `p-4` on a
    // file the audit had just declared clean.
    if (shorthands.has(rule.target)) {
        return null;
    }

    const indices = rule.sources.map((shorthand) => shorthands.get(shorthand));
    if (indices.some((index) => index === undefined)) {
        return null;
    }

    const ordered = [...indices].sort((a, b) => a - b);
    const base = parsed[ordered[0]];
    const targetUtility = `${negative}${targetBody}${value ? `-${value}` : ""}`;
    const targetRaw = buildFixToken({
        variants: base.variants,
        utility: targetUtility,
        important: base.important,
    });

    const conflict = mergeHasValueConflict(bodyValues, family, rule.sources, rule.target, clusterKey);
    if (!mergeIsRenderSafe(
        groupRaws,
        ordered.map((index) => tokens[index]),
        targetRaw,
        conflict,
        mergeSafety,
    )) {
        return null;
    }

    return { indices: ordered, targetUtility };
}

function findFamilyMergeInGroup(groupIndices, tokens, parsed, mergeSafety) {
    const groupRaws = groupIndices.map((index) => tokens[index]);
    const { familyClusters, familyBodyValues } = clusterTokensByFamily(groupIndices, {
        getUtility: (index) => parsed[index].utility,
        getSlot: (index) => index,
    });

    for (const [family, clusters] of familyClusters.entries()) {
        const bodyValues = familyBodyValues.get(family);

        for (const [clusterKey, cluster] of clusters.entries()) {
            for (const rule of FAMILY_MERGE_RULES) {
                const result = tryFamilyMergeRule(rule, {
                    family,
                    clusterKey,
                    cluster,
                    bodyValues,
                    groupRaws,
                    tokens,
                    parsed,
                    mergeSafety,
                });
                if (result) {
                    return result;
                }
            }
        }
    }

    return null;
}

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
        // The table first, one merge at a time, exactly as before the engine
        // existed; only once it has nothing left in this group does the
        // engine add the merges the table does not make (planEngineCollapse),
        // all at once since their sources are disjoint.
        const result = findFamilyMergeInGroup(groupIndices, tokens, parsed, mergeSafety);
        if (result) {
            return [result];
        }
        const engineMerges = planEngineGroupMerges(groupIndices, tokens, parsed, mergeSafety);
        if (engineMerges.length > 0) {
            return engineMerges;
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
        let merges = findFamilyMerge(tokens, mergeSafety);
        merges;
        merges = findFamilyMerge(tokens, mergeSafety)
    ) {
        // Merges found together have disjoint sources, so every index still
        // points at the original token until the removals run, highest first.
        const removed = [];
        for (const { indices, targetUtility } of merges) {
            const base = parseFixToken(tokens[indices[0]]);
            // Preserve the position of the earliest source token so unrelated
            // utilities keep their relative order in the output.
            tokens[indices[0]] = buildFixToken({
                variants: base.variants,
                utility: targetUtility,
                important: base.important,
            });
            removed.push(...indices.slice(1));
        }
        for (const index of removed.sort((a, b) => b - a)) {
            tokens.splice(index, 1);
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
// Try every COMPOSITE_EQUIVALENCE_RULES rule against one variant/important
// group; applies (mutates tokens) and returns true on the first rule that
// fires. Split out of mergeFixCompositeEquivalences's pass/group/rule loop.
function applyCompositeMergeInGroup(groupIndices, tokens, parsed, mergeSafety) {
    const groupRaws = groupIndices.map((index) => tokens[index]);
    const utilities = new Set(groupIndices.map((index) => parsed[index].utility));
    const firstIndexByUtility = new Map();
    for (const index of groupIndices) {
        if (!firstIndexByUtility.has(parsed[index].utility)) {
            firstIndexByUtility.set(parsed[index].utility, index);
        }
    }

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
        return true;
    }

    return false;
}

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
            if (applyCompositeMergeInGroup(groupIndices, tokens, parsed, mergeSafety)) {
                // Indices are stale after the splice; recompute. Every merge
                // removes at least one token, so this terminates.
                mutated = true;
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
// Record one (family, shorthand) match for token `i` into the cluster maps.
// Split out of clusterTokensByFamily's triple-nested loop.
function recordFamilyMatch({ family, shorthand }, {
    i,
    tokens,
    clusterKey,
    matched,
    candidateBody,
    getSlot,
    familyClusters,
    familyBodyValues,
    longestBodyPerToken,
}) {
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
            for (const match of matches) {
                recordFamilyMatch(match, {
                    i,
                    tokens,
                    clusterKey,
                    matched,
                    candidateBody,
                    getSlot,
                    familyClusters,
                    familyBodyValues,
                    longestBodyPerToken,
                });
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

// Try one FAMILY_MERGE_RULES rule against one (family, cluster) pair for the
// audit path; emits a suggestion when the rule applies. Mirrors
// tryFamilyMergeRule on the fix side.
function tryFamilyShorthandRule(rule, { family, clusterKey, cluster, bodyValues, groupRaws, tokens, filePath, line, column, found, mergeSafety }) {
    if (rule.corners && !family.supportsCorners) {
        return;
    }
    const { negative, value, shorthands } = cluster;
    const get = (short) => shorthands.get(short) ?? null;
    const has = (short) => Boolean(get(short));

    if (has(rule.target) || !rule.sources.every(has)) {
        return;
    }

    const body = family.shorthandToBody.get(rule.target);
    if (!body) {
        return;
    }
    const utility = `${negative}${body}${value ? `-${value}` : ""}`;
    const target = formatClass(tokens[0].variants, tokens[0].important, utility);

    const sources = rule.sources.map(get);
    const conflict = mergeHasValueConflict(bodyValues, family, rule.sources, rule.target, clusterKey);
    if (!mergeIsRenderSafe(
        groupRaws,
        sources.map((token) => token.raw),
        target,
        conflict,
        mergeSafety,
    )) {
        return;
    }

    emitSuggestion(found, filePath, line, column, sources, target);
    return sources;
}

function detectFamilyShorthand(groupedTokens, filePath, line, column, found, mergeSafety = null) {
    for (const tokens of groupedTokens.values()) {
        const claimedRaws = new Set();
        const { familyClusters, familyBodyValues } = clusterTokensByFamily(tokens, {
            getUtility: (token) => token.utility,
            getSlot: (token) => token,
        });
        const groupRaws = tokens.map((token) => token.raw);

        for (const [family, clusters] of familyClusters.entries()) {
            const bodyValues = familyBodyValues.get(family);

            for (const [clusterKey, cluster] of clusters.entries()) {
                for (const rule of FAMILY_MERGE_RULES) {
                    const sources = tryFamilyShorthandRule(rule, {
                        family,
                        clusterKey,
                        cluster,
                        bodyValues,
                        groupRaws,
                        tokens,
                        filePath,
                        line,
                        column,
                        found,
                        mergeSafety,
                    });
                    for (const source of sources ?? []) {
                        claimedRaws.add(source.raw);
                    }
                }
            }
        }

        // Same precedence as findFamilyMerge on the fix side: the table's
        // findings stand, and the engine only adds merges they leave out.
        const planned = planEngineCollapse(
            tokens,
            (utility) => formatClass(tokens[0].variants, tokens[0].important, utility),
            mergeSafety,
            claimedRaws,
        );
        for (const { sourceEntries, targetRaw } of planned) {
            emitSuggestion(found, filePath, line, column, sourceEntries, targetRaw);
        }
    }
}

export {
    detectComplexEquivalences,
    detectFamilyShorthand,
    maybePushFinding,
    mergeFixCompositeEquivalences,
    mergeFixFamilyShorthand,
    mergeFixWidthHeight,
    toRelative,
};
