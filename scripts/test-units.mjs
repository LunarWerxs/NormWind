#!/usr/bin/env node
/**
 * Unit tests for the pure modules under lib/.
 *
 * Everything else in this repo tests NormWind by spawning the CLI and diffing
 * its output. That is the right shape for end-to-end behavior, but it makes a
 * bug in a pure function reachable only through a full scan/extract/fix round
 * trip. These tests import the functions directly instead, so a failure points
 * at one function rather than at "something in the pipeline".
 *
 * Only genuinely pure modules belong here. The stateful core (Tailwind runtime,
 * caches, theme-var resolver, scan orchestration) is still covered end-to-end
 * by test-prepush.mjs.
 */

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isSingleCssValue, winningDeclarations } from "../lib/css.mjs";
import { globPatternToRegExp, hasGlobSyntax } from "../lib/glob.mjs";
import { buildLineStarts, indexToLineCol, splitTemplateStaticChunks } from "../lib/text.mjs";
import {
    getKnownCanonicalClass,
    isLikelyFixUtility,
    isLikelyTailwindUtility,
    matchUtilityToBody,
    parseClassToken,
    parseFixToken,
    parseToken,
    stripBracketedSegments,
} from "../lib/tokens.mjs";
import { expandValueVariants, extractFractionPercent, pxToRem, remToPx } from "../lib/units.mjs";
import { buildSarifReport } from "../lib/sarif.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let assertions = 0;

function check(label, actual, expected) {
    assertions += 1;
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures += 1;
        console.log(`[FAIL] ${label}`);
        console.log(`  expected: ${b}`);
        console.log(`  actual:   ${a}`);
    }
}

function ok(label, condition) {
    check(label, Boolean(condition), true);
}

// --------------------------------------------------------------------------
// tokens
// --------------------------------------------------------------------------
check("parseToken splits variants and utility", parseToken("hover:focus:p-4").utility, "p-4");
check("parseToken keeps the variant prefix", parseToken("hover:focus:p-4").variants, "hover:focus:");
check("parseToken normalizes a leading important marker", parseToken("!p-4").normalized, "p-4!");
check("parseToken normalizes a post-variant marker", parseToken("hover:!p-4").normalized, "hover:p-4!");
check("parseToken leaves a trailing marker alone", parseToken("p-4!").normalized, "p-4!");
check("parseToken treats a doubled marker as important once", parseToken("!p-4!").normalized, "p-4!");
// The audit and fix parsers must agree; they were separate implementations
// once, and the whole "audit clean implies fix is a no-op" contract rests on
// them never disagreeing.
for (const raw of ["p-4", "!p-4", "p-4!", "hover:!p-4", "md:hover:mx-2", "-mt-4", "[&>svg]:size-4"]) {
    const audit = parseClassToken(raw);
    const fix = parseFixToken(raw);
    check(`token parsers agree on utility for ${raw}`, fix.utility, audit.utility);
    check(`token parsers agree on variants for ${raw}`, fix.variants, audit.variants);
    check(`token parsers agree on important for ${raw}`, fix.important, audit.important);
}

check("stripBracketedSegments empties arbitrary values", stripBracketedSegments("data-[state=open]:bg-red-500"), "data-[]:bg-red-500");
check("stripBracketedSegments handles nested brackets", stripBracketedSegments("grid-cols-[1fr_[full]_1fr]"), "grid-cols-[]");
check("stripBracketedSegments leaves plain tokens alone", stripBracketedSegments("px-4"), "px-4");

ok("bracket variants count as fixable utilities", isLikelyFixUtility("[&>svg]:size-4"));
ok("data-attribute variants count as fixable utilities", isLikelyFixUtility("data-[state=open]:bg-red-500"));
ok("a JSX expression fragment does not", !isLikelyFixUtility("a>b"));
ok("bare `border` is a utility", isLikelyTailwindUtility(parseClassToken("border")));
ok("a bare word is not", !isLikelyTailwindUtility(parseClassToken("hello")));

check("matchUtilityToBody splits a compound utility", matchUtilityToBody("px-4", "px"), { negative: "", value: "4" });
check("matchUtilityToBody handles negatives", matchUtilityToBody("-mt-4", "mt"), { negative: "-", value: "4" });
check("matchUtilityToBody matches a bare body", matchUtilityToBody("border", "border"), { negative: "", value: "" });
check("matchUtilityToBody rejects a non-match", matchUtilityToBody("px-4", "py"), null);

check("known canonical replacement applies", getKnownCanonicalClass("break-words"), "wrap-break-word");
check("known canonical replacement keeps variants", getKnownCanonicalClass("hover:break-words"), "hover:wrap-break-word");
check("unknown utilities are left alone", getKnownCanonicalClass("px-4"), null);

// --------------------------------------------------------------------------
// units
// --------------------------------------------------------------------------
check("rem converts to px", remToPx("1.5rem"), "24px");
check("px converts to rem", pxToRem("24px"), "1.5rem");
check("non-length input is rejected", remToPx("auto"), null);
check("fractions become percentages", extractFractionPercent("1/3"), "33.333333%");
check("a zero denominator is rejected", extractFractionPercent("1/0"), null);
check("value variants include both units", expandValueVariants("1rem").sort(), ["16px", "1rem"]);

// --------------------------------------------------------------------------
// glob
// --------------------------------------------------------------------------
ok("glob syntax is detected", hasGlobSyntax("src/**/*.vue"));
ok("a plain path is not a glob", !hasGlobSyntax("src/App.vue"));
ok("** spans directories", globPatternToRegExp("src/**/*.vue").test("src/a/b/C.vue"));
ok("** also matches zero directories", globPatternToRegExp("src/**/*.vue").test("src/C.vue"));
ok("a rooted pattern does not match elsewhere", !globPatternToRegExp("src/*.vue").test("other/C.vue"));
ok("a bare pattern matches at any depth", globPatternToRegExp("*.vue").test("a/b/C.vue"));
ok("brace alternation works", globPatternToRegExp("*.{vue,tsx}").test("a/B.tsx"));
ok("brace alternation excludes others", !globPatternToRegExp("*.{vue,tsx}").test("a/B.ts"));

// --------------------------------------------------------------------------
// text
// --------------------------------------------------------------------------
const lineStarts = buildLineStarts("a\nbb\nccc");
check("line starts are indexed", lineStarts, [0, 2, 5]);
check("offset 0 is line 1 column 1", indexToLineCol(lineStarts, 0), { line: 1, column: 1 });
check("offset 6 is line 3 column 2", indexToLineCol(lineStarts, 6), { line: 3, column: 2 });

// The partial token butting against `${` is dropped so a bare `h-` never
// surfaces, but the complete token before it survives.
check(
    "template chunks drop only the token touching an interpolation",
    splitTemplateStaticChunks("px-4 h-${size} py-4").map((c) => c.text),
    ["px-4 ", " py-4"],
);
check(
    "a template with no interpolation is one chunk",
    splitTemplateStaticChunks("px-4 py-4").map((c) => c.text),
    ["px-4 py-4"],
);

// --------------------------------------------------------------------------
// css
// --------------------------------------------------------------------------
ok("calc() counts as a single value", isSingleCssValue("calc(var(--spacing) * 4)"));
ok("a plain length is a single value", isSingleCssValue("4px"));
ok("a two-value shorthand is not", !isSingleCssValue("1px 2px"));
ok("nested functions stay single", isSingleCssValue("var(--a, calc(1px + 2px))"));

// --------------------------------------------------------------------------
// sarif
// --------------------------------------------------------------------------
const sarif = buildSarifReport(
    [{ filePath: "src/A.vue", line: 3, column: 7, message: "x" }],
    1,
    { version: "9.9.9", ruleId: "tailwindcss/enforces-shorthand" },
);
check("SARIF version", sarif.version, "2.1.0");
check("SARIF driver version", sarif.runs[0].tool.driver.version, "9.9.9");
check("SARIF result location", sarif.runs[0].results[0].locations[0].physicalLocation.region, { startLine: 3, startColumn: 7 });

// --------------------------------------------------------------------------
// css equivalence against the real Tailwind engine
//
// This is the guard that decides whether a shorthand merge is allowed to be
// applied, so it is worth asserting against the actual design system rather
// than a fixture of its output.
// --------------------------------------------------------------------------
const require_ = createRequire(path.join(REPO_ROOT, "package.json"));
const tailwindModule = await import(pathToFileURL(require_.resolve("tailwindcss")).href);
const tailwind = tailwindModule.__unstable__loadDesignSystem ? tailwindModule : tailwindModule.default;
const indexCssPath = require_.resolve("tailwindcss/index.css");
const designSystem = await tailwind.__unstable__loadDesignSystem(
    await fs.readFile(indexCssPath, "utf8"),
    { from: indexCssPath },
);

function rendersIdentically(before, after) {
    const a = winningDeclarations(designSystem, before);
    const b = winningDeclarations(designSystem, after);
    if (!a || !b || a.size !== b.size) {
        return false;
    }
    for (const [property, value] of a) {
        if (b.get(property) !== value) {
            return false;
        }
    }
    return true;
}

const EQUIVALENCE_CASES = [
    ["px-4 py-4 collapses to p-4", ["px-4", "py-4"], ["p-4"], true],
    ["w-6 h-6 collapses to size-6", ["w-6", "h-6"], ["size-6"], true],
    ["four sides collapse to the axes", ["border-8", "border-t-4", "border-r-4", "border-b-4", "border-l-4"], ["border-8", "border-y-4", "border-x-4"], true],
    ["a border color does not block a width merge", ["border-red-500", "border-t-4", "border-r-4", "border-b-4", "border-l-4"], ["border-red-500", "border-4"], true],
    ["truncate is exactly its three parts", ["overflow-hidden", "text-ellipsis", "whitespace-nowrap"], ["truncate"], true],
    // The regressions that motivated the guard. Each of these WAS applied by
    // --fix and each silently changed the rendered box.
    ["a wider border-all must block the four-sides merge", ["border-8", "border-t-4", "border-r-4", "border-b-4", "border-l-4"], ["border-8", "border-4"], false],
    ["a wider mx must block the l/r merge", ["mx-8", "ml-2", "mr-2"], ["mx-8", "mx-2"], false],
    ["a wider size must block the w/h merge", ["size-8", "w-4", "h-4"], ["size-8", "size-4"], false],
    ["a shadowed duplicate width must block the merge", ["w-4", "w-6", "h-6"], ["w-4", "size-6"], false],
];

for (const [label, before, after, expected] of EQUIVALENCE_CASES) {
    check(`css equivalence: ${label}`, rendersIdentically(before, after), expected);
}

console.log("");
console.log(`${assertions} unit assertions, ${failures} failures.`);
process.exitCode = failures > 0 ? 1 : 0;
