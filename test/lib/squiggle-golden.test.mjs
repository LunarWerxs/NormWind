// WHY: every expected.golden.txt is written by renderSquiggleGolden itself, so
// a renderer bug would be baked into all of them and still compare equal. This
// pins the placement rules against a hand-written expectation: squiggles go
// under whole class tokens only (h-5 inside min-h-5 is not a hit), and follow
// a class string that wraps past the line the finding is reported on.
import test from "node:test";
import assert from "node:assert/strict";

import { renderSquiggleGolden } from "../../scripts/squiggle-golden.mjs";

const RULE = "tailwindcss/enforces-shorthand";
const MESSAGE = "Classnames 'w-5, h-5' could be replaced by the 'size-5' shorthand!";

test("squiggles mark whole tokens across a wrapped class string, then the fix output", () => {
    const source = '<div class="min-h-5 w-5\n            h-5">x</div>\n';
    const fixed = '<div class="min-h-5 size-5">x</div>\n';
    const golden = renderSquiggleGolden({
        fileName: "input.vue",
        source,
        ruleId: RULE,
        findings: [{ line: 1, column: 13, message: MESSAGE }],
        fixed,
        fixall: fixed,
    });
    assert.equal(
        golden,
        [
            "==== input.vue (1 finding) ====",
            '<div class="min-h-5 w-5',
            `${" ".repeat(20)}~~~`,
            `!!! ${RULE}: ${MESSAGE}`,
            '            h-5">x</div>',
            `${" ".repeat(12)}~~~`,
            "",
            "=== FIXED (--fix) ===",
            '<div class="min-h-5 size-5">x</div>',
            "",
            "=== FIXED (--fixall) ===",
            "(same as --fix)",
            "",
        ].join("\n"),
    );
});
