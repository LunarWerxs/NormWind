// WHY: the regression and parity checks run their fixtures through mapPool so
// CI stays well inside its timeout. These pin the two promises the checks rely
// on: results come back in the order of the fixtures (so a report reads the
// same however the runs finish), and no more than `limit` runs are in flight.
import test from "node:test";
import assert from "node:assert/strict";

import { fixtureJobs, mapPool } from "../../scripts/cli-harness.mjs";

test("mapPool keeps the input order when later items finish first", async () => {
    const delays = [30, 5, 20, 1, 10];
    const results = await mapPool(delays, 3, async (ms, index) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return `${index}:${ms}`;
    });
    assert.deepStrictEqual(results, ["0:30", "1:5", "2:20", "3:1", "4:10"]);
});

test("mapPool never runs more than its limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
    });
    assert.strictEqual(peak, 4);
});

test("mapPool handles an empty list and a limit larger than the list", async () => {
    assert.deepStrictEqual(await mapPool([], 4, async (x) => x), []);
    assert.deepStrictEqual(await mapPool([1, 2], 10, async (x) => x * 2), [2, 4]);
});

test("fixtureJobs honours NORMWIND_FIXTURE_JOBS and otherwise stays between 1 and 8", () => {
    const previous = process.env.NORMWIND_FIXTURE_JOBS;
    try {
        process.env.NORMWIND_FIXTURE_JOBS = "3";
        assert.strictEqual(fixtureJobs(), 3);
        process.env.NORMWIND_FIXTURE_JOBS = "not-a-number";
        const fallback = fixtureJobs();
        assert.ok(fallback >= 1 && fallback <= 8, `fallback ${fallback}`);
    } finally {
        if (previous === undefined) delete process.env.NORMWIND_FIXTURE_JOBS;
        else process.env.NORMWIND_FIXTURE_JOBS = previous;
    }
});
