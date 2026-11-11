#!/usr/bin/env node

// The CLI itself: discover files, run the two-pass scan over them, report.
// Every rule, cache and rewrite it drives lives in ../lib.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
    CANONICAL_MEMO,
    getCanonicalizeCandidate,
    loadCanonicalSnapshot,
    loadDiskCache,
    lookupCanonicalFromMemo,
    peekCanonicalizerPromise,
    saveDiskCache,
    warmCanonicalMemo,
} from "../lib/canonical-cache.mjs";
import { applyBaseline, readBaselineFile } from "../lib/baseline.mjs";
import { cleanupCanonicalArtifacts, extractCanonicalReplacements } from "../lib/canonical-extract.mjs";
import { countChangedFiles, partitionFindingsByChangedLines, readChangedLines } from "../lib/changed-lines.mjs";
import { extractClassLikeStrings } from "../lib/class-extraction.mjs";
import { parseArgs, printHelp } from "../lib/cli-args.mjs";
import { FILE_SCAN_CONCURRENCY, runWithConcurrency } from "../lib/concurrency.mjs";
import { isMarkupFile, listTargetFiles, loadIgnoreConfig } from "../lib/discovery.mjs";
import { applyFixes } from "../lib/fix.mjs";
import {
    MAX_MERGE_SAFETY_ROUNDS,
    createMergeSafetyProbe,
    resolvePendingMergeChecks,
} from "../lib/merge-safety.mjs";
import { buildSarifReport } from "../lib/sarif.mjs";
import { useProjectThemeCss } from "../lib/design-system.mjs";
import { MAX_SCANNED_FILE_BYTES } from "../lib/scan-config.mjs";
import {
    detectComplexEquivalences,
    detectFamilyShorthand,
    maybePushFinding,
    toRelative,
} from "../lib/shorthand.mjs";
import { buildLineStarts, indexToLineCol } from "../lib/text.mjs";
import {
    buildThemeVarCacheKey,
    getActiveThemeCssHash,
    getThemeVarResolver,
    lookupThemeVarReplacementFromMemo,
    peekThemeVarResolverPromise,
    tokenLooksLikeNamedThemeVarCandidate,
} from "../lib/theme-vars.mjs";
import {
    formatClass,
    getKnownCanonicalClass,
    isLikelyFixUtility,
    isLikelyTailwindUtility,
    parseClassToken,
} from "../lib/tokens.mjs";
import { NORMWINDS_VERSION } from "../lib/workspace.mjs";

const RULE_ID = "tailwindcss/enforces-shorthand";

// Precompute class snippets and gather all arbitrary-value tokens up front,
// then canonicalize each unique cache miss once. Non-arbitrary tokens
// are never canonicalized because Tailwind's canonicalizer is a no-op for them
// (verified empirically: 0/27,060 non-arbitrary tokens changed in this
// codebase). This removes the majority of Tailwind design-system calls.
// Index which tokens in each snippet are arbitrary-value / named-theme-var
// candidates, and collect the unique raws for global cache pre-warming.
// Split out of scanFileForStaticShorthand's per-snippet loop.
function collectSnippetArbitraryRaws(snippets, suggestNamedThemeVars, uniqueArbitraryRaws, uniqueThemeVarRaws) {
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
    return { perSnippetArbitraryRaws, hasAnyArbitrary };
}

// Pass-1 per-file scan: read, size-check, extract class snippets, and index
// arbitrary/theme-var candidate tokens. Split out of
// collectStaticShorthandFindings's first runWithConcurrency callback, which
// was an inline anonymous closure carrying the same weight as everything
// around it.
async function scanFileForStaticShorthand(filePath, idx, state) {
    const {
        fileContexts,
        uniqueArbitraryRaws,
        uniqueThemeVarRaws,
        scanFailures,
        scanSkipped,
        suggestNamedThemeVars,
        lintedFilesCounter,
    } = state;

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
        lintedFilesCounter.count += 1;
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
    lintedFilesCounter.count += 1;
    if (snippets.length === 0) {
        fileContexts[idx] = null;
        return;
    }

    // Collect arbitrary raw tokens (containing `[` or `(--`) for global
    // cache pre-warming. Also note which snippets need the
    // canonicalizer / theme-var resolver.
    const { perSnippetArbitraryRaws, hasAnyArbitrary } = collectSnippetArbitraryRaws(
        snippets,
        suggestNamedThemeVars,
        uniqueArbitraryRaws,
        uniqueThemeVarRaws,
    );

    fileContexts[idx] = {
        filePath,
        snippets,
        lineStarts: buildLineStarts(sourceText),
        perSnippetArbitraryRaws,
        hasAnyArbitrary,
        hasAnyThemeVarCandidate: suggestNamedThemeVars && sourceText.includes("(--"),
    };
}

// Emit findings for one snippet's arbitrary-value tokens (canonicalize, then
// chain into named-theme-var resolution). Split out of
// processFileContextForStaticFindings's per-snippet loop.
function emitArbitraryTokenFindings(snippet, arbitraryRaws, lineStarts, { canonicalizeCandidate, themeVarLookup, relativePath, localFound }) {
    for (const { raw, snippetOffset } of arbitraryRaws) {
        let suggestion = null;

        if (canonicalizeCandidate && raw.includes("[")) {
            const tailwindCanonical = canonicalizeCandidate(raw);
            if (tailwindCanonical && tailwindCanonical !== raw) {
                suggestion = tailwindCanonical;
            }
        }

        // Chain canonicalize -> named-theme-var. When Tailwind canonicalizes
        // `border-[var(--x)]/40` to `border-(--x)/40`, the resolver should
        // still get a chance to collapse the var ref to the named utility
        // (`border-x/40`). Operate on the post-canonical string so the final
        // emitted suggestion is the most specific one we can prove safe.
        const themeInput = suggestion ?? raw;
        if (themeVarLookup && tokenLooksLikeNamedThemeVarCandidate(themeInput)) {
            const themeReplacement = themeVarLookup(themeInput);
            if (themeReplacement && themeReplacement !== themeInput) {
                suggestion = themeReplacement;
            }
        }

        if (suggestion) {
            const { line, column } = indexToLineCol(lineStarts, snippet.index + snippetOffset);
            maybePushFinding(localFound, {
                filePath: relativePath,
                line,
                column,
                message: `The class '${raw}' can be written as '${suggestion}'`,
            });
        }
    }
}

// Emit findings for one snippet's known-canonical/important-shorthand
// tokens, and return the parsed Tailwind-utility tokens for the grouped
// shorthand pass. Split out of processFileContextForStaticFindings's
// per-snippet loop.
function emitKnownCanonicalFindings(snippet, lineStarts, { relativePath, localFound }) {
    const tokenRegex = /\S+/g;
    let tokenMatch;
    const parsedTokens = [];

    while ((tokenMatch = tokenRegex.exec(snippet.value)) !== null) {
        const token = parseClassToken(tokenMatch[0]);
        if (!isLikelyTailwindUtility(token)) {
            continue;
        }

        // Each token keeps its own position so a multi-token finding can sit
        // on the tokens it names (lib/shorthand.mjs locateSources).
        const { line, column } = indexToLineCol(lineStarts, snippet.index + tokenMatch.index);
        parsedTokens.push({ ...token, line, column });

        // v3 optimization: avoid the Tailwind canonicalizer for general
        // non-arbitrary tokens, but still report explicit known aliases.
        const knownCanonical = getKnownCanonicalClass(token.raw);
        if (knownCanonical || (token.importantPrefix && !token.importantSuffix)) {
            const canonical = knownCanonical ?? formatClass(token.variants, true, token.utility);
            maybePushFinding(localFound, {
                filePath: relativePath,
                line,
                column,
                message: `The class '${token.raw}' can be written as '${canonical}'`,
            });
        }
    }

    return parsedTokens;
}

// Group one snippet's parsed tokens by variant/important and run the family
// shorthand + composite equivalence audits over them. Split out of
// processFileContextForStaticFindings's per-snippet loop.
function emitGroupedShorthandFindings(snippet, parsedTokens, lineStarts, { relativePath, localFound, mergeSafety }) {
    const grouped = new Map();
    for (const token of parsedTokens) {
        const key = `${token.variants}|${token.important ? "1" : "0"}`;
        if (!grouped.has(key)) {
            grouped.set(key, []);
        }

        grouped.get(key).push(token);
    }

    const snippetAnchor = indexToLineCol(lineStarts, snippet.index);
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

// Run all three static-finding passes over one snippet. Split out of
// processFileContextForStaticFindings's per-snippet loop.
function processStaticSnippet(snippet, arbitraryRaws, lineStarts, deps) {
    if (arbitraryRaws && arbitraryRaws.length > 0) {
        emitArbitraryTokenFindings(snippet, arbitraryRaws, lineStarts, deps);
    }

    const parsedTokens = emitKnownCanonicalFindings(snippet, lineStarts, deps);

    if (parsedTokens.length > 1) {
        emitGroupedShorthandFindings(snippet, parsedTokens, lineStarts, deps);
    }
}

// Pass-2 per-file detection sweep: resolve the (pre-warmed) canonicalizer and
// theme-var lookups for this file, then run every snippet through them. Split
// out of collectStaticShorthandFindings's runDetectionSweep, which was an
// inline anonymous closure nested inside another closure.
async function processFileContextForStaticFindings(ctx, suggestNamedThemeVars, mergeSafety) {
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

    // If every arbitrary token is cached, we never loaded Tailwind. Use the
    // cache-only lookup; otherwise fall through to the full canonicalizer
    // (already warmed above).
    let canonicalizeCandidate = null;
    if (hasAnyArbitrary) {
        const warmedCanonicalizer = peekCanonicalizerPromise();
        canonicalizeCandidate = warmedCanonicalizer
            ? await warmedCanonicalizer
            : lookupCanonicalFromMemo;
    }

    let themeVarLookup = null;
    if (suggestNamedThemeVars && hasAnyThemeVarCandidate) {
        const warmedThemeVars = peekThemeVarResolverPromise();
        themeVarLookup = warmedThemeVars
            ? await warmedThemeVars.catch(() => null)
            : lookupThemeVarReplacementFromMemo;
    }

    const deps = { canonicalizeCandidate, themeVarLookup, relativePath, localFound, mergeSafety };
    for (let si = 0; si < snippets.length; si++) {
        processStaticSnippet(snippets[si], perSnippetArbitraryRaws[si], lineStarts, deps);
    }

    return [...localFound.values()];
}

async function collectStaticShorthandFindings(filePaths, { suggestNamedThemeVars = false, themeCssPath = null } = {}) {
    // Pass 1: read every file, extract class snippets, and collect unique
    // arbitrary tokens across the entire set for cache pre-warming.
    const fileContexts = new Array(filePaths.length);
    const uniqueArbitraryRaws = new Set();
    const uniqueThemeVarRaws = new Set();
    const scanFailures = [];
    const scanSkipped = [];
    const lintedFilesCounter = { count: 0 };
    const scanState = {
        fileContexts,
        uniqueArbitraryRaws,
        uniqueThemeVarRaws,
        scanFailures,
        scanSkipped,
        suggestNamedThemeVars,
        lintedFilesCounter,
    };
    await runWithConcurrency(
        filePaths,
        FILE_SCAN_CONCURRENCY,
        (filePath, idx) => scanFileForStaticShorthand(filePath, idx, scanState),
    );

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
        await getCanonicalizeCandidate();
        await warmCanonicalMemo(cacheMisses);
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
                if (!CANONICAL_MEMO.has(buildThemeVarCacheKey(raw, getActiveThemeCssHash()))) {
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
    const runDetectionSweep = (mergeSafety) => runWithConcurrency(
        fileContexts,
        FILE_SCAN_CONCURRENCY,
        (ctx) => processFileContextForStaticFindings(ctx, suggestNamedThemeVars, mergeSafety),
    );

    let perFileFindings = [];
    for (let round = 0; round < MAX_MERGE_SAFETY_ROUNDS; round += 1) {
        const probe = createMergeSafetyProbe();
        perFileFindings = await runDetectionSweep(probe);
        if (!(await resolvePendingMergeChecks(probe.pending, probe.pendingCollapses))) {
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
        lintedFiles: lintedFilesCounter.count,
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


function nextStepHint({ fix = false, fixAll = false, dryRun = false } = {}) {
    if (!fix) {
        return "Run with --fix (or --fixall) to apply safe rewrites automatically.";
    }
    if (dryRun) {
        return "Run again without --dry-run to apply the rewrites listed above.";
    }
    if (!fixAll) {
        return "These remain after --fix: --fixall also rewrites .js/.ts-family files; anything else needs a manual change.";
    }
    return "These remain after --fixall and need a manual change.";
}

function printTextReport(findings, lintedFiles, fixOptions = {}) {
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

    console.log(`\n${nextStepHint(fixOptions)}`);
}

// The maintenance modes return before any scanning happens.
function isMaintenanceMode({ checkCanonical, extractCanonical, cleanupCanonicalFiles }) {
    return checkCanonical || extractCanonical || cleanupCanonicalFiles;
}

// Each find*Error helper below returns the usage error to print, or null when
// its checks pass. They run in main()'s original validation order.
function findFlagInputError({ unknownFlags, missingValueFlags, unexpectedValueFlags, invalidReporter, suggestNamedThemeVars, themeCssPath }) {
    if (unknownFlags.length > 0) {
        return `normwinds: unknown flag(s): ${unknownFlags.join(", ")}\n`
            + "Run `normwinds --help` for the list of supported flags.";
    }
    if (unexpectedValueFlags.length > 0) {
        return `normwinds: ${unexpectedValueFlags.join(", ")}: this flag is a switch and takes no value (pass it to turn it on, leave it out to keep it off).`;
    }
    if (missingValueFlags.length > 0) {
        return `normwinds: ${missingValueFlags.join(", ")} requires a value (e.g. --theme-css src/assets/main.css).`;
    }
    if (invalidReporter !== null) {
        return `normwinds: unknown --reporter "${invalidReporter}". Supported: text, json, sarif.`;
    }
    if (suggestNamedThemeVars && !themeCssPath) {
        return "normwinds: --suggest-named-theme-vars requires --theme-css <path-to-project-tailwind.css>.";
    }
    return null;
}

// Pairing a maintenance mode with scan-time flags used to drop those flags in silence.
function findMaintenanceFixError(maintenanceMode, { fix, dryRun }) {
    if (maintenanceMode && (fix || dryRun)) {
        return "normwinds: --fix/--fixall/--dry-run cannot be combined with --check-canonical, --extract-canonical, or --cleanup-canonical-files.";
    }
    return null;
}

function findDiffBaseFlagError(maintenanceMode, { diffBase, fix }) {
    if (diffBase !== null && !diffBase.trim()) {
        return "normwinds: --diff-base requires a ref (e.g. --diff-base origin/main).";
    }
    // --diff-base narrows the REPORT to changed lines; a fix rewrites whole
    // files. Together they used to produce a repository-wide diff on exactly
    // the legacy codebase --diff-base exists to adopt gently.
    if (diffBase !== null && fix) {
        return "normwinds: --fix/--fixall cannot be combined with --diff-base: a fix rewrites every finding in the files it touches, not just changed lines. Pass the changed files as targets instead (e.g. normwinds --fix $(git diff --name-only origin/main)).";
    }
    if (maintenanceMode && diffBase !== null) {
        return "normwinds: --diff-base cannot be combined with --check-canonical, --extract-canonical, or --cleanup-canonical-files.";
    }
    return null;
}

function findDryRunError({ dryRun, fix }) {
    if (dryRun && !fix) {
        return "normwinds: --dry-run only applies with --fix or --fixall.";
    }
    return null;
}

function findBaselineFlagError(maintenanceMode, { baselinePath, updateBaseline }) {
    if (maintenanceMode && (baselinePath || updateBaseline)) {
        return "normwinds: --baseline/--update-baseline cannot be combined with --check-canonical, --extract-canonical, or --cleanup-canonical-files.";
    }
    if (updateBaseline && !baselinePath) {
        return "normwinds: --update-baseline requires --baseline <file>.";
    }
    return null;
}

function findFlagCombinationError(options) {
    const maintenanceMode = isMaintenanceMode(options);
    return findMaintenanceFixError(maintenanceMode, options)
        ?? findDiffBaseFlagError(maintenanceMode, options)
        ?? findDryRunError(options)
        ?? findBaselineFlagError(maintenanceMode, options);
}

// A --baseline that is missing or malformed fails up front: treating it as
// empty would fail every legacy finding at once, and there is no safe
// permissive reading of a broken file. Only --update-baseline may create it.
async function findBaselineFileError({ baselinePath, updateBaseline }) {
    if (!baselinePath) {
        return null;
    }
    try {
        const { exists } = await readBaselineFile(baselinePath);
        if (!exists && !updateBaseline) {
            return `normwinds: --baseline "${baselinePath}" does not exist. Create it once with --baseline "${baselinePath}" --update-baseline.`;
        }
    } catch (error) {
        const reason = error?.message || String(error);
        return reason.startsWith("normwinds:") ? reason : `normwinds: failed to read --baseline "${baselinePath}": ${reason}`;
    }
    return null;
}

// An explicitly-requested --theme-css that cannot be loaded is a
// misconfiguration, not a degraded mode: fail loud up front instead of
// silently disabling the feature for the whole run. The resolver promise
// is cached, so this costs nothing when the path is valid.
async function findThemeCssError(options) {
    const { themeCssPath } = options;
    if (!themeCssPath || isMaintenanceMode(options)) {
        return null;
    }
    try {
        await getThemeVarResolver({ themeCssPath });
    } catch (error) {
        const reason = error?.message || String(error);
        return reason.startsWith("normwinds:")
            ? reason
            : `normwinds: failed to load --theme-css "${themeCssPath}": ${reason}`;
    }
    return null;
}

// Handle every early-return branch of main() that needs no file scan:
// --help/--version, argument validation errors, and the --theme-css
// preflight check. Returns true when the caller should return immediately.
async function handleEarlyExit(options) {
    if (options.help) {
        printHelp();
        return true;
    }

    if (options.version) {
        console.log(NORMWINDS_VERSION);
        return true;
    }

    const error = findFlagInputError(options)
        ?? findFlagCombinationError(options)
        ?? (await findBaselineFileError(options))
        ?? (await findThemeCssError(options));
    if (error === null) {
        return false;
    }
    console.error(error);
    process.exitCode = 2;
    return true;
}

// Print the scan report in the requested format (sarif/json/text). Split out
// of main's reporter if/else-if/else chain.
function printScanReport(reporter, findings, lintedFiles, { diffGate = null, baseline = null, fixOptions = {} } = {}) {
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
                    ...(diffGate
                        ? { diffBase: diffGate.diffBase, unchangedLineFindingCount: diffGate.unchangedCount }
                        : {}),
                    // Present only with --baseline, so the shape of a plain run is unchanged.
                    ...(baseline ? { baseline } : {}),
                },
                null,
                2,
            ),
        );
    } else {
        printTextReport(findings, lintedFiles, fixOptions);
    }
}

// The maintenance modes read, write or delete ./docs/reference/*, which is
// NormWind's own reference data. Run anywhere else, --check-canonical always
// failed and --cleanup-canonical-files deleted a project's files unasked, so
// they only run inside a NormWind checkout.
async function isNormwindCheckout() {
    try {
        const pkg = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"));
        return pkg?.name === "@lunawerx/normwind";
    } catch {
        return false;
    }
}

// Run --cleanup-canonical-files / --check-canonical / --extract-canonical.
// Returns true when one of them ran, so main() returns without scanning.
async function runMaintenanceMode({ cleanupCanonicalFiles, checkCanonical, extractCanonical, writeCanonicalFiles }) {
    if ((cleanupCanonicalFiles || checkCanonical || extractCanonical) && !(await isNormwindCheckout())) {
        console.error(
            "normwinds: --check-canonical, --extract-canonical and --cleanup-canonical-files maintain NormWind's own reference data and only run inside a NormWind checkout (package.json name @lunawerx/normwind). The installed package already carries a validated snapshot.",
        );
        process.exitCode = 2;
        return true;
    }
    if (cleanupCanonicalFiles) {
        await cleanupCanonicalArtifacts();
        console.log(`normwinds v${NORMWINDS_VERSION}: removed canonical generated artifacts (if present).`);
        return true;
    }

    if (checkCanonical) {
        await extractCanonicalReplacements({ writeFiles: false, checkOnly: true });
        return true;
    }

    if (extractCanonical) {
        await extractCanonicalReplacements({ writeFiles: writeCanonicalFiles });
        return true;
    }

    return false;
}

// Read the --diff-base changed lines. Returns { changedLines }, or null after
// reporting the failure (exit 2) so the caller returns.
async function readDiffBaseLines(diffBase) {
    try {
        return { changedLines: await readChangedLines(diffBase, { cwd: process.cwd() }) };
    } catch (error) {
        console.error(`normwinds: --diff-base: ${error?.message || String(error)}`);
        process.exitCode = 2;
        return null;
    }
}

async function loadScanCaches() {
    await loadDiskCache();
    await loadCanonicalSnapshot();
}

async function loadTargetFiles(patterns, ignorePatterns) {
    await loadIgnoreConfig(ignorePatterns);
    const [targets] = await Promise.all([listTargetFiles(patterns), loadScanCaches()]);
    return targets;
}

// Exit 2, not 0. A typo'd path in a CI step used to be indistinguishable
// from a clean audit, so the job went green having scanned nothing. A file
// argument that is ignored or of an unsupported type matches nothing too
// (it never widens the scan), and is named so the user sees why.
// Returns true when the caller should return.
function stopOnEmptyMatch(patterns, { files, refusedFiles }, allowEmpty) {
    if (patterns.length === 0 || files.length > 0 || allowEmpty) {
        return false;
    }
    console.error(
        `normwinds: the given pattern(s) matched no lintable files: ${patterns.join(", ")}`,
    );
    if (refusedFiles.length > 0) {
        console.error(
            `Not scanned (ignored, or not a .vue/.svelte/.astro/.html/.js/.ts-family file): ${refusedFiles.join(", ")}`,
        );
    }
    console.error(
        "Check the path, or pass --allow-empty if matching nothing is expected.",
    );
    process.exitCode = 2;
    return true;
}

// Apply --fix/--fixall and return how many files could not be written.
// --diff-base is refused with a fix (findDiffBaseFlagError), so no finding
// line read before the rewrite needs re-reading after it.
async function runFixPass(filePaths, { fixAll, suggestNamedThemeVars, themeCssPath, dryRun }) {
    const fixResult = await applyFixes(filePaths, { fixAll, suggestNamedThemeVars, themeCssPath, dryRun });
    return fixResult.failed + fixResult.skipped;
}

// The count ratchet runs after the scan, on the finished finding list, so
// every reporter and the exit code below see only what the baseline does
// not already hold (new findings, plus notes for counts to lower).
async function applyBaselineGate(findings, filePaths, scanIssues, { baselinePath, updateBaseline }) {
    if (!baselinePath) {
        return { findings, summary: null };
    }
    const baselineResult = await applyBaseline({
        baselinePath,
        update: updateBaseline,
        findings,
        scannedPaths: filePaths.map(toRelative),
        scanComplete: scanIssues === 0,
        ruleId: RULE_ID,
    });
    return { findings: baselineResult.findings, summary: baselineResult.summary };
}

function resolveFindingPath(finding) {
    return path.resolve(process.cwd(), finding.filePath);
}

// Changed-line gating runs after the baseline, which has to count every
// finding in a file to judge it; the gate then narrows what is reported.
function applyDiffGate(findings, changedLines, diffBase, filePaths) {
    if (!changedLines) {
        return { findings, diffGate: null };
    }
    const { changed, unchanged } = partitionFindingsByChangedLines(
        findings,
        changedLines,
        resolveFindingPath,
    );
    const scannedPaths = filePaths.map((filePath) => path.resolve(process.cwd(), filePath));
    if (changedLines.size > 0 && countChangedFiles(changedLines, scannedPaths) === 0) {
        console.error(
            `normwinds: --diff-base ${diffBase}: git reports changed files, but none of the scanned files match them; check that the working directory path matches the repository path.`,
        );
    }
    if (unchanged.length > 0) {
        console.error(
            `normwinds: --diff-base ${diffBase}: ${unchanged.length} finding(s) on unchanged lines not reported (run without --diff-base to list them).`,
        );
    }
    return { findings: changed, diffGate: { diffBase, unchangedCount: unchanged.length } };
}

// Exit 2 distinguishes a partial-failure run (some files couldn't be written)
// from a clean audit (0) or one that merely found lint issues (1), so CI can
// tell the difference.
function auditExitCode(fixIssues, scanIssues, findingCount) {
    if (fixIssues > 0 || scanIssues > 0) {
        return 2;
    }
    return findingCount > 0 ? 1 : 0;
}

async function runAudit(parsedArgs) {
    const { allowEmpty, diffBase, fix, ignorePatterns, patterns, reporter, suggestNamedThemeVars, themeCssPath } = parsedArgs;

    // Read the diff before scanning so a missing ref or a non-git directory
    // fails fast instead of after a full audit.
    let changedLines = null;
    if (diffBase) {
        const diff = await readDiffBaseLines(diffBase);
        if (!diff) {
            return;
        }
        changedLines = diff.changedLines;
    }

    // The project theme judges every rewrite, so it is in place before the
    // caches (keyed by it) are read. The preflight already loaded it.
    if (themeCssPath) {
        await useProjectThemeCss(themeCssPath);
    }

    const targets = await loadTargetFiles(patterns, ignorePatterns);
    if (stopOnEmptyMatch(patterns, targets, allowEmpty)) {
        return;
    }
    const filePaths = targets.files;

    const fixIssues = fix ? await runFixPass(filePaths, parsedArgs) : 0;

    const scanResult = await collectStaticShorthandFindings(filePaths, { suggestNamedThemeVars, themeCssPath });
    const { lintedFiles, skipped: scanSkipped, failures: scanFailures } = scanResult;
    printScanIssueSummary(scanSkipped, scanFailures);
    const scanIssues = scanSkipped.length + scanFailures.length;

    await saveDiskCache();

    const baselined = await applyBaselineGate(scanResult.findings, filePaths, scanIssues, parsedArgs);
    const { findings, diffGate } = applyDiffGate(baselined.findings, changedLines, diffBase, filePaths);

    printScanReport(reporter, findings, lintedFiles, {
        diffGate,
        baseline: baselined.summary,
        fixOptions: { fix, fixAll: parsedArgs.fixAll, dryRun: parsedArgs.dryRun },
    });

    process.exitCode = auditExitCode(fixIssues, scanIssues, findings.length);
}

async function main() {
    const parsedArgs = parseArgs(process.argv.slice(2));

    if (await handleEarlyExit(parsedArgs)) {
        return;
    }

    if (await runMaintenanceMode(parsedArgs)) {
        return;
    }

    await runAudit(parsedArgs);
}

// A `normwinds:` error is an expected refusal (an unsupported Tailwind, an
// Action limit, an unreadable theme) and its message says everything; only an
// unexpected crash gets the stack trace a bug report needs.
main().catch((error) => {
    const message = error?.message || String(error);
    if (message.startsWith("normwinds:")) {
        console.error(message);
    } else {
        console.error("normwinds: failed to run shorthand audit.");
        console.error(error);
    }
    process.exitCode = 2;
});
