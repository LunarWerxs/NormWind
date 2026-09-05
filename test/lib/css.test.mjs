// WHY: moved out of scripts/test-units.mjs (2026-09-05), see test/lib/tokens.test.mjs
// for the full rationale. Behavior preserved exactly. The design-system-backed
// equivalence checks for this same module live in test/lib/css-equivalence.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

import { isSingleCssValue } from "../../lib/css.mjs";

test("calc() counts as a single value", () => {
    assert.ok(isSingleCssValue("calc(var(--spacing) * 4)"));
});

test("a plain length is a single value", () => {
    assert.ok(isSingleCssValue("4px"));
});

test("a two-value shorthand is not", () => {
    assert.ok(!isSingleCssValue("1px 2px"));
});

test("nested functions stay single", () => {
    assert.ok(isSingleCssValue("var(--a, calc(1px + 2px))"));
});
