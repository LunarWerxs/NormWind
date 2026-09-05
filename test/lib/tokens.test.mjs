// WHY: moved out of scripts/test-units.mjs (2026-09-05) so `node --test`
// discovers this file on its own, instead of a hand-maintained script that a
// new test file could never join. Behavior preserved exactly; every check()
// / ok() call from the original became one test() here, no assertion dropped.
import test from "node:test";
import assert from "node:assert/strict";

import {
    getKnownCanonicalClass,
    isLikelyFixUtility,
    isLikelyTailwindUtility,
    matchUtilityToBody,
    parseClassToken,
    parseFixToken,
    parseToken,
    stripBracketedSegments,
} from "../../lib/tokens.mjs";

test("parseToken splits variants and utility", () => {
    assert.strictEqual(parseToken("hover:focus:p-4").utility, "p-4");
});

test("parseToken keeps the variant prefix", () => {
    assert.strictEqual(parseToken("hover:focus:p-4").variants, "hover:focus:");
});

test("parseToken normalizes a leading important marker", () => {
    assert.strictEqual(parseToken("!p-4").normalized, "p-4!");
});

test("parseToken normalizes a post-variant marker", () => {
    assert.strictEqual(parseToken("hover:!p-4").normalized, "hover:p-4!");
});

test("parseToken leaves a trailing marker alone", () => {
    assert.strictEqual(parseToken("p-4!").normalized, "p-4!");
});

test("parseToken treats a doubled marker as important once", () => {
    assert.strictEqual(parseToken("!p-4!").normalized, "p-4!");
});

// The audit and fix parsers must agree; they were separate implementations
// once, and the whole "audit clean implies fix is a no-op" contract rests on
// them never disagreeing.
for (const raw of ["p-4", "!p-4", "p-4!", "hover:!p-4", "md:hover:mx-2", "-mt-4", "[&>svg]:size-4"]) {
    test(`token parsers agree on utility for ${raw}`, () => {
        assert.strictEqual(parseFixToken(raw).utility, parseClassToken(raw).utility);
    });
    test(`token parsers agree on variants for ${raw}`, () => {
        assert.strictEqual(parseFixToken(raw).variants, parseClassToken(raw).variants);
    });
    test(`token parsers agree on important for ${raw}`, () => {
        assert.strictEqual(parseFixToken(raw).important, parseClassToken(raw).important);
    });
}

test("stripBracketedSegments empties arbitrary values", () => {
    assert.strictEqual(stripBracketedSegments("data-[state=open]:bg-red-500"), "data-[]:bg-red-500");
});

test("stripBracketedSegments handles nested brackets", () => {
    assert.strictEqual(stripBracketedSegments("grid-cols-[1fr_[full]_1fr]"), "grid-cols-[]");
});

test("stripBracketedSegments leaves plain tokens alone", () => {
    assert.strictEqual(stripBracketedSegments("px-4"), "px-4");
});

test("bracket variants count as fixable utilities", () => {
    assert.ok(isLikelyFixUtility("[&>svg]:size-4"));
});

test("data-attribute variants count as fixable utilities", () => {
    assert.ok(isLikelyFixUtility("data-[state=open]:bg-red-500"));
});

test("a JSX expression fragment does not", () => {
    assert.ok(!isLikelyFixUtility("a>b"));
});

test("bare `border` is a utility", () => {
    assert.ok(isLikelyTailwindUtility(parseClassToken("border")));
});

test("a bare word is not", () => {
    assert.ok(!isLikelyTailwindUtility(parseClassToken("hello")));
});

test("matchUtilityToBody splits a compound utility", () => {
    assert.deepStrictEqual(matchUtilityToBody("px-4", "px"), { negative: "", value: "4" });
});

test("matchUtilityToBody handles negatives", () => {
    assert.deepStrictEqual(matchUtilityToBody("-mt-4", "mt"), { negative: "-", value: "4" });
});

test("matchUtilityToBody matches a bare body", () => {
    assert.deepStrictEqual(matchUtilityToBody("border", "border"), { negative: "", value: "" });
});

test("matchUtilityToBody rejects a non-match", () => {
    assert.strictEqual(matchUtilityToBody("px-4", "py"), null);
});

test("known canonical replacement applies", () => {
    assert.strictEqual(getKnownCanonicalClass("break-words"), "wrap-break-word");
});

test("known canonical replacement keeps variants", () => {
    assert.strictEqual(getKnownCanonicalClass("hover:break-words"), "hover:wrap-break-word");
});

test("unknown utilities are left alone", () => {
    assert.strictEqual(getKnownCanonicalClass("px-4"), null);
});
