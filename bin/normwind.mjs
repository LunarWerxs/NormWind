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
} from "../lib/canonical-cache.mjs";
import { cleanupCanonicalArtifacts, extractCanonicalReplacements } from "../lib/canonical-extract.mjs";
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
import { MAX_LIVE_CANONICALIZATION_CANDIDATES, MAX_SCANNED_FILE_BYTES } from "../lib/scan-config.mjs";
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

        parsedTokens.push(token);

        // v3 optimization: avoid the Tailwind canonicalizer for general
        // non-arbitrary tokens, but still report explicit known aliases.
        const knownCanonical = getKnownCanonicalClass(token.raw);
        if (knownCanonical || (token.importantPrefix && !token.importantSuffix)) {
            const canonical = knownCanonical ?? formatClass(token.variants, true, token.utility);
            const { line, column } = indexToLineCol(lineStarts, snippet.index + tokenMatch.index);
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

// Handle every early-return branch of main() that needs no file scan:
// --help/--version, argument validation errors, and the --theme-css
// preflight check. Returns true when the caller should return immediately.
// Split out of main's long flat sequence of validation ifs.
async function handleEarlyExit({
    help,
    version,
    unknownFlags,
    missingValueFlags,
    invalidReporter,
    suggestNamedThemeVars,
    themeCssPath,
    fix,
    dryRun,
    checkCanonical,
    extractCanonical,
    cleanupCanonicalFiles,
}) {
    if (help) {
        printHelp();
        return true;
    }

    if (version) {
        console.log(NORMWINDS_VERSION);
        return true;
    }

    if (unknownFlags.length > 0) {
        console.error(`normwinds: unknown flag(s): ${unknownFlags.join(", ")}`);
        console.error("Run `normwinds --help` for the list of supported flags.");
        process.exitCode = 2;
        return true;
    }

    if (missingValueFlags.length > 0) {
        console.error(
            `normwinds: ${missingValueFlags.join(", ")} requires a value (e.g. --theme-css src/assets/main.css).`,
        );
        process.exitCode = 2;
        return true;
    }

    if (invalidReporter !== null) {
        console.error(
            `normwinds: unknown --reporter "${invalidReporter}". Supported: text, json, sarif.`,
        );
        process.exitCode = 2;
        return true;
    }

    if (suggestNamedThemeVars && !themeCssPath) {
        console.error(
            "normwinds: --suggest-named-theme-vars requires --theme-css <path-to-project-tailwind.css>.",
        );
        process.exitCode = 2;
        return true;
    }

    // The maintenance modes below return before any scanning happens, so
    // pairing them with scan-time flags used to drop those flags in silence.
    const maintenanceMode = checkCanonical || extractCanonical || cleanupCanonicalFiles;
    if (maintenanceMode && (fix || dryRun)) {
        console.error(
            "normwinds: --fix/--fixall/--dry-run cannot be combined with --check-canonical, --extract-canonical, or --cleanup-canonical-files.",
        );
        process.exitCode = 2;
        return true;
    }
    if (dryRun && !fix) {
        console.error("normwinds: --dry-run only applies with --fix or --fixall.");
        process.exitCode = 2;
        return true;
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
            return true;
        }
    }

    return false;
}

// Print the scan report in the requested format (sarif/json/text). Split out
// of main's reporter if/else-if/else chain.
function printScanReport(reporter, findings, lintedFiles) {
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
}

async function main() {
    const parsedArgs = parseArgs(process.argv.slice(2));
    const {
        allowEmpty,
        checkCanonical,
        cleanupCanonicalFiles,
        dryRun,
        extractCanonical,
        fix,
        fixAll,
        ignorePatterns,
        patterns,
        reporter,
        suggestNamedThemeVars,
        themeCssPath,
        writeCanonicalFiles,
    } = parsedArgs;

    if (await handleEarlyExit(parsedArgs)) {
        return;
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

    printScanReport(reporter, findings, lintedFiles);

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
