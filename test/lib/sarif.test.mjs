// WHY: moved out of scripts/test-units.mjs (2026-09-05), see test/lib/tokens.test.mjs
// for the full rationale. Behavior preserved exactly.
import test from "node:test";
import assert from "node:assert/strict";

import { buildSarifReport } from "../../lib/sarif.mjs";

const sarif = buildSarifReport(
    [{ filePath: "src/A.vue", line: 3, column: 7, message: "x" }],
    1,
    { version: "9.9.9", ruleId: "tailwindcss/enforces-shorthand" },
);

test("SARIF version", () => {
    assert.strictEqual(sarif.version, "2.1.0");
});

test("SARIF driver version", () => {
    assert.strictEqual(sarif.runs[0].tool.driver.version, "9.9.9");
});

test("SARIF result location", () => {
    assert.deepStrictEqual(sarif.runs[0].results[0].locations[0].physicalLocation.region, { startLine: 3, startColumn: 7 });
});
