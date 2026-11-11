// The --fix path: rewriting class strings on disk.
//
// The write side of the audit. It re-derives its own findings rather than
// consuming the audit's, because a fix has to be computed from the exact source
// text it will be applied to and re-proved safe after every merge round.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
    getKnownCanonicalClass,
    isLikelyFixUtility,
    parseFixToken,
    stripBracketedSegments,
} from "./tokens.mjs";
import {
    CANONICAL_MEMO,
    getCanonicalizeCandidate,
    lookupCanonicalFromMemo,
    warmCanonicalMemo,
} from "./canonical-cache.mjs";
import { extractClassLikeStrings } from "./class-extraction.mjs";
import { isMarkupFile } from "./discovery.mjs";
import {
    MAX_MERGE_SAFETY_ROUNDS,
    createMergeSafetyProbe,
    resolvePendingMergeChecks,
} from "./merge-safety.mjs";
import { MAX_SCANNED_FILE_BYTES } from "./scan-config.mjs";
import {
    mergeFixCompositeEquivalences,
    mergeFixFamilyShorthand,
    mergeFixWidthHeight,
} from "./shorthand.mjs";
import { getThemeVarResolver, tokenLooksLikeNamedThemeVarCandidate } from "./theme-vars.mjs";

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

// Normalize one token in place (canonical spelling, known-canonical lookup,
// bracket canonicalization, named theme-var resolution). Returns whether it
// changed. Split out of transformFixableClassContent's per-token loop.
function normalizeFixToken(tokens, i, canonicalizeCandidate, themeVarResolver) {
    let changed = false;

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
        return changed;
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

    return changed;
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
        changed = normalizeFixToken(tokens, i, canonicalizeCandidate, themeVarResolver) || changed;
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

    return `${leading}${rejoinPreservingLayout(middle, tokens)}${trailing}`;
}

// Longest-common-subsequence alignment of the original tokens with the
// rewritten ones: which original index each surviving token keeps.
function alignTokens(original, rewritten) {
    const rows = original.length + 1;
    const cols = rewritten.length + 1;
    const table = Array.from({ length: rows }, () => new Uint16Array(cols));
    for (let i = original.length - 1; i >= 0; i -= 1) {
        for (let j = rewritten.length - 1; j >= 0; j -= 1) {
            table[i][j] = original[i] === rewritten[j]
                ? table[i + 1][j + 1] + 1
                : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < original.length && j < rewritten.length) {
        if (original[i] === rewritten[j]) {
            pairs.push([i, j]);
            i += 1;
            j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            i += 1;
        } else {
            j += 1;
        }
    }
    return pairs;
}

// Re-join rewritten tokens with the class string's OWN separators, so a
// wrapped or aligned multi-line class list keeps its layout. Rewrites only
// replace a token in place or drop one (a merge's target takes its first
// source's slot), so each rewritten token is placed in an original slot: an
// unchanged token in its own, a replacement in the slot of the token it
// replaced. A dropped token takes one adjacent separator with it, preferring
// one without a line break so the lines stay as they were.
function rejoinPreservingLayout(middle, rewritten) {
    const parts = middle.split(/(\s+)/);
    const original = parts.filter((_, index) => index % 2 === 0);
    const separators = parts.filter((_, index) => index % 2 === 1);
    if (original.length === rewritten.length) {
        return original.map((_, index) => `${rewritten[index]}${separators[index] ?? ""}`).join("");
    }

    // slotToken[i]: the token that occupies original slot i, or null if dropped.
    const slotToken = new Array(original.length).fill(null);
    const extras = [];
    const anchors = [...alignTokens(original, rewritten), [original.length, rewritten.length]];
    let previous = [-1, -1];
    for (const [oi, ri] of anchors) {
        const gapOriginal = [];
        for (let k = previous[0] + 1; k < oi; k += 1) gapOriginal.push(k);
        const gapRewritten = rewritten.slice(previous[1] + 1, ri);
        gapRewritten.forEach((token, index) => {
            if (index < gapOriginal.length) {
                slotToken[gapOriginal[index]] = token;
            } else {
                extras.push(token);
            }
        });
        if (oi < original.length) {
            slotToken[oi] = original[oi];
        }
        previous = [oi, ri];
    }

    const keptSeparators = [...separators];
    const dropped = new Set();
    for (let index = 0; index < original.length; index += 1) {
        if (slotToken[index] !== null) {
            continue;
        }
        dropped.add(index);
        const after = keptSeparators[index];
        const before = index > 0 ? keptSeparators[index - 1] : undefined;
        if (after !== undefined && (!after.includes("\n") || before === undefined)) {
            keptSeparators[index] = "";
        } else if (before !== undefined) {
            keptSeparators[index - 1] = after ?? "";
            keptSeparators[index] = "";
        }
    }

    let out = "";
    for (let index = 0; index < original.length; index += 1) {
        if (!dropped.has(index)) {
            out += slotToken[index];
        }
        out += keptSeparators[index] ?? "";
    }
    out = out.replace(/\s+$/, "");
    return extras.length > 0 ? `${out} ${extras.join(" ")}` : out;
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
            // A class attribute's value is a class list by position, so it
            // takes the single-token rule markup files get; the audit reports
            // every token in it, and fix-then-audit has to converge.
            if (!looksLikeFixableClassString(span.value, {
                allowSingleTokenCanonical: allowSingleTokenCanonical || span.classAttribute === true,
            })) {
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

// Stat + validate one candidate file before attempting to fix it. Returns
// {stats} on success, or {skip: reason} / {fail: error} for the caller to
// record and continue past. Split out of applyFixes' per-file loop.
async function statFileForFix(filePath) {
    try {
        const stats = await fs.lstat(filePath);
        if (stats.isSymbolicLink()) {
            return { skip: "symbolic-link targets are not rewritten" };
        }
        if (!stats.isFile()) {
            return { skip: "target is not a regular file" };
        }
        if (stats.size > MAX_SCANNED_FILE_BYTES) {
            return { skip: `exceeds ${MAX_SCANNED_FILE_BYTES}-byte scan limit (${stats.size} bytes)` };
        }
        return { stats };
    } catch (error) {
        return { fail: error };
    }
}

// Warm the memo with the bracket tokens this file introduces (in engine-sized
// batches, see lib/canonical-cache.mjs), lazily resolving the shared live
// canonicalizer the first time one is needed. `state.sharedCanonicalizer` is
// shared across files.
async function resolveFixCanonicalizer(bracketCandidates, state) {
    let hasCanonicalCacheMiss = false;
    for (const candidate of bracketCandidates) {
        if (!CANONICAL_MEMO.has(candidate)) {
            hasCanonicalCacheMiss = true;
            break;
        }
    }
    if (hasCanonicalCacheMiss) {
        if (!state.sharedCanonicalizer) {
            state.sharedCanonicalizer = await getCanonicalizeCandidate();
        }
        await warmCanonicalMemo(bracketCandidates);
    }
    return bracketCandidates.size > 0
        ? (state.sharedCanonicalizer ?? lookupCanonicalFromMemo)
        : null;
}

// Test-only fault injection for the fault-isolation checks in
// scripts/check-prepush.mjs. Every hook is inert unless NORMWIND_TEST_HOOKS=1
// is ALSO set, so a stray NORMWIND_TEST_* variable in a user's environment can
// never fail, or append to, their source files.
const TEST_HOOKS_ENABLED = process.env.NORMWIND_TEST_HOOKS === "1";

function testHookTargets(name, filePath) {
    return TEST_HOOKS_ENABLED && process.env[name] === path.basename(filePath);
}

// Write the transformed content via temp-file + rename, refusing to clobber
// a file that changed on disk since it was read. Split out of applyFixes'
// per-file try block.
async function writeFixedFile(filePath, transformed, originalStats, sourceText) {
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
        if (testHookTargets("NORMWIND_TEST_FORCE_WRITE_FAIL", filePath)) {
            const forced = new Error("normwinds: forced write failure (NORMWIND_TEST_FORCE_WRITE_FAIL)");
            forced.code = "EPERM";
            throw forced;
        }
        if (testHookTargets("NORMWIND_TEST_MUTATE_BEFORE_RENAME", filePath)) {
            await fs.appendFile(filePath, "\n// simulated concurrent editor save\n", "utf8");
        }

        // Refuse to replace a file that changed after we read it. This
        // closes the common editor-save race where an atomic rename would
        // otherwise preserve a valid file while still discarding newer user
        // content.
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
}

// Transform + (unless dryRun) write one already-read file. Returns whether it
// was fixed (dry-run counts as fixed for reporting purposes, same as before
// this was split out). Split out of applyFixes' per-file try block.
async function fixOneFile(filePath, sourceText, originalStats, { sharedThemeVarResolver, canonicalizerState, dryRun }) {
    // Test-only hook (see TEST_HOOKS_ENABLED) that forces a transform throw
    // for one named file, so the fault-isolation contract can be exercised
    // deterministically without crafting input that breaks the real parser.
    if (testHookTargets("NORMWIND_TEST_FORCE_TRANSFORM_THROW", filePath)) {
        throw new Error("normwinds: forced transform throw (NORMWIND_TEST_FORCE_TRANSFORM_THROW)");
    }

    const allowSingleTokenCanonical = isMarkupFile(filePath);
    const bracketCandidates = collectBracketFixCandidates(sourceText, allowSingleTokenCanonical, filePath);
    const canonicalizeCandidate = await resolveFixCanonicalizer(bracketCandidates, canonicalizerState);
    const themeVarResolver = sharedThemeVarResolver && /\(--|\[var\(--/.test(sourceText)
        ? sharedThemeVarResolver
        : null;
    // Merge safety is resolved lazily: each attempt answers from the memo
    // and records the pairs it cannot answer, then those are resolved and
    // the transform replayed. Merges are iterative, so a second round can
    // expose a pair the first never reached; loop until nothing new is
    // recorded. Only a file that actually contains a conflicting class list
    // pays for the design system, and after the first such file the memo
    // serves the rest.
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
        if (!(await resolvePendingMergeChecks(probe.pending, probe.pendingCollapses))) {
            break;
        }
    }
    if (!changed) {
        return false;
    }

    if (dryRun) {
        // Keep --json stdout machine-parseable. Human progress belongs on
        // stderr in both text and JSON modes.
        console.error(`normwinds: [dry-run] would rewrite ${filePath}`);
        return true;
    }

    // Write-then-rename so a crash or Ctrl-C mid-write can never leave the
    // user's source file truncated: the original stays intact until the
    // replacement is fully on disk. rename() is atomic on the same volume,
    // which the sibling temp path guarantees.
    await writeFixedFile(filePath, transformed, originalStats, sourceText);
    return true;
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
    const canonicalizerState = { sharedCanonicalizer: null };

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

        const statResult = await statFileForFix(filePath);
        if (statResult.skip) {
            skipped.push({ filePath, reason: statResult.skip });
            continue;
        }
        if (statResult.fail) {
            failures.push({ filePath, stage: "read", error: statResult.fail });
            continue;
        }
        const originalStats = statResult.stats;

        let sourceText;
        try {
            const bytes = await fs.readFile(filePath);
            sourceText = bytes.toString("utf8");
            // A file in another encoding (Latin-1, UTF-16, Shift-JIS) decodes
            // with U+FFFD in place of every invalid byte; writing that back
            // would corrupt the whole file, not just the class string.
            if (!Buffer.from(sourceText, "utf8").equals(bytes)) {
                skipped.push({ filePath, reason: "not valid UTF-8; rewriting it would corrupt its other bytes" });
                continue;
            }
        } catch (error) {
            failures.push({ filePath, stage: "read", error });
            continue;
        }

        // Isolate transform + write per file. A transform edge case, or a write
        // error such as EBUSY/EPERM (an editor or antivirus holding the file open
        // on Windows) or ENOSPC, must skip this one file and continue, not stop
        // the whole run. The write itself stays atomic (temp file + rename).
        try {
            if (await fixOneFile(filePath, sourceText, originalStats, { sharedThemeVarResolver, canonicalizerState, dryRun })) {
                changedFiles += 1;
            }
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

export { applyFixes, rejoinPreservingLayout };
