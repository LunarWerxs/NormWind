// WHY: pins the --baseline count ratchet (lib/baseline.mjs), the contract a
// legacy repo relies on to adopt NormWind in CI: findings a file already had
// stay quiet, one more fails, a drop must be lowered, and --update-baseline
// can only lower. Each test fails if that rule is removed or loosened.
import test from "node:test";
import assert from "node:assert/strict";

import {
    compareWithBaseline,
    parseBaseline,
    planBaselineUpdate,
    serializeBaseline,
} from "../../lib/baseline.mjs";

const finding = (filePath, line) => ({ filePath, line, column: 1, message: `finding ${line}` });

test("baseline: findings within a file's count are held back", () => {
    const result = compareWithBaseline(
        [finding("src/A.vue", 3), finding("src/A.vue", 9)],
        new Map([["src/A.vue", 2]]),
        { scannedFiles: new Set(["src/A.vue"]) },
    );
    assert.deepStrictEqual(result.findings, []);
    assert.strictEqual(result.suppressed, 2);
});

test("baseline: one finding over the count reports every finding in that file", () => {
    const result = compareWithBaseline(
        [finding("src/A.vue", 3), finding("src/A.vue", 9), finding("src/B.vue", 1)],
        new Map([["src/A.vue", 1], ["src/B.vue", 1]]),
        { scannedFiles: new Set(["src/A.vue", "src/B.vue"]) },
    );
    assert.deepStrictEqual(result.findings.map((f) => `${f.filePath}:${f.line}`), ["src/A.vue:3", "src/A.vue:9"]);
    assert.deepStrictEqual(result.exceeded, [{ filePath: "src/A.vue", count: 2, allowed: 1 }]);
});

test("baseline: a count that dropped fails until lowered; unscanned entries are left alone", () => {
    const result = compareWithBaseline(
        [finding("src/A.vue", 3)],
        new Map([["src/A.vue", 2], ["src/Unscanned.vue", 5], ["src/Deleted.vue", 1]]),
        { scannedFiles: new Set(["src/A.vue"]), goneFiles: new Set(["src/Deleted.vue"]) },
    );
    assert.deepStrictEqual(result.stale.map((s) => s.filePath), ["src/A.vue", "src/Deleted.vue"]);
    assert.strictEqual(result.findings.length, 2);
    assert.match(result.findings[0].message, /--update-baseline/);
});

test("baseline: --update-baseline refuses to raise a count or add a file", () => {
    const plan = planBaselineUpdate(
        [finding("src/A.vue", 3), finding("src/New.vue", 1)],
        new Map([["src/A.vue", 1]]),
        { exists: true, scannedFiles: new Set(["src/A.vue", "src/New.vue"]) },
    );
    assert.strictEqual(plan.next, null);
    assert.deepStrictEqual(plan.raised.map((r) => r.filePath), ["src/New.vue"]);
});

test("baseline: --update-baseline lowers, drops cleared files, keeps unscanned ones", () => {
    const plan = planBaselineUpdate(
        [finding("src/A.vue", 3)],
        new Map([["src/A.vue", 3], ["src/Clean.vue", 2], ["src/Unscanned.vue", 4]]),
        { exists: true, scannedFiles: new Set(["src/A.vue", "src/Clean.vue"]) },
    );
    assert.deepStrictEqual([...plan.next], [["src/A.vue", 1], ["src/Unscanned.vue", 4]]);
});

test("baseline: first --update-baseline adopts every current count", () => {
    const plan = planBaselineUpdate(
        [finding("src/A.vue", 3), finding("src/A.vue", 4)],
        new Map(),
        { exists: false, scannedFiles: new Set(["src/A.vue"]) },
    );
    assert.deepStrictEqual([...plan.next], [["src/A.vue", 2]]);
});

test("baseline: serialize round-trips and a malformed file is rejected", () => {
    const counts = new Map([["src/B.vue", 1], ["src/A.vue", 2]]);
    assert.deepStrictEqual(parseBaseline(serializeBaseline(counts, "rule")), new Map([["src/A.vue", 2], ["src/B.vue", 1]]));
    assert.throws(() => parseBaseline('{"version":1,"files":{"src/A.vue":-1}}'), /non-negative integer/);
    assert.throws(() => parseBaseline('{"files":{}}'), /unsupported version/);
});
