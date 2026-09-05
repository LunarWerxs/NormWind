// WHY: moved out of scripts/test-units.mjs (2026-09-05), see test/lib/tokens.test.mjs
// for the full rationale. Behavior preserved exactly.
import test from "node:test";
import assert from "node:assert/strict";

import { expandValueVariants, extractFractionPercent, pxToRem, remToPx } from "../../lib/units.mjs";

test("rem converts to px", () => {
    assert.strictEqual(remToPx("1.5rem"), "24px");
});

test("px converts to rem", () => {
    assert.strictEqual(pxToRem("24px"), "1.5rem");
});

test("non-length input is rejected", () => {
    assert.strictEqual(remToPx("auto"), null);
});

test("fractions become percentages", () => {
    assert.strictEqual(extractFractionPercent("1/3"), "33.333333%");
});

test("a zero denominator is rejected", () => {
    assert.strictEqual(extractFractionPercent("1/0"), null);
});

test("value variants include both units", () => {
    assert.deepStrictEqual(expandValueVariants("1rem").sort(), ["16px", "1rem"]);
});
