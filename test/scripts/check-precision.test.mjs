// WHY: the rewrite-precision gate (scripts/check-precision.mjs) is only worth
// having if it fails closed. These pin the scoring seam: a corpus with no cases
// on one side of the label must fail rather than read as a perfect score, and a
// metric past its floor must fail the gate.
import test from "node:test";
import assert from "node:assert/strict";

import { FLOORS, gateFailures, scoreConfusion } from "../../scripts/check-precision.mjs";

test("precision gate: metrics come from the confusion counts", () => {
    const metrics = scoreConfusion({ tp: 9, fp: 1, fn: 1, tn: 9 });
    assert.strictEqual(metrics.precision, 0.9);
    assert.strictEqual(metrics.recall, 0.9);
    assert.strictEqual(metrics.falsePositiveRate, 0.1);
    assert.deepStrictEqual(gateFailures("rewrite", metrics), []);
});

test("precision gate: an empty side of the label fails instead of passing vacuously", () => {
    const metrics = scoreConfusion({ tp: 0, fp: 0, fn: 0, tn: 0 });
    assert.strictEqual(metrics.precision, null);
    assert.strictEqual(gateFailures("rewrite", metrics).length, 3);
});

test("precision gate: a noisy rule fails on precision and false-positive rate", () => {
    const failures = gateFailures("detection", scoreConfusion({ tp: 10, fp: 3, fn: 0, tn: 7 }));
    assert.strictEqual(failures.length, 2);
    assert.match(failures[0], /precision/);
    assert.match(failures[1], /falsePositiveRate/);
});

test("precision gate: floors are the published ones", () => {
    assert.deepStrictEqual({ ...FLOORS }, { precision: 0.9, recall: 0.85, falsePositiveRate: 0.1 });
});
