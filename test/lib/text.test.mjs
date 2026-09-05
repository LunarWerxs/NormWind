// WHY: moved out of scripts/test-units.mjs (2026-09-05), see test/lib/tokens.test.mjs
// for the full rationale. Behavior preserved exactly.
import test from "node:test";
import assert from "node:assert/strict";

import { buildLineStarts, indexToLineCol, splitTemplateStaticChunks } from "../../lib/text.mjs";

const lineStarts = buildLineStarts("a\nbb\nccc");

test("line starts are indexed", () => {
    assert.deepStrictEqual(lineStarts, [0, 2, 5]);
});

test("offset 0 is line 1 column 1", () => {
    assert.deepStrictEqual(indexToLineCol(lineStarts, 0), { line: 1, column: 1 });
});

test("offset 6 is line 3 column 2", () => {
    assert.deepStrictEqual(indexToLineCol(lineStarts, 6), { line: 3, column: 2 });
});

// The partial token butting against `${` is dropped so a bare `h-` never
// surfaces, but the complete token before it survives.
test("template chunks drop only the token touching an interpolation", () => {
    assert.deepStrictEqual(
        splitTemplateStaticChunks("px-4 h-${size} py-4").map((c) => c.text),
        ["px-4 ", " py-4"],
    );
});

test("a template with no interpolation is one chunk", () => {
    assert.deepStrictEqual(
        splitTemplateStaticChunks("px-4 py-4").map((c) => c.text),
        ["px-4 py-4"],
    );
});
