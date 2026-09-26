// WHY: Tailwind's own collapse (lib/engine-collapse.mjs) adds shorthand merges
// on top of the vendored eslint-plugin-tailwindcss table. These tests pin the
// seam between the two against the real bundled engine:
// - contract: for the merges the table has always made, the engine proposes the
//   same shorthand from the same sources (a Tailwind upgrade that stops
//   collapsing one fails here);
// - contract: the engine only adds; a table finding survives whatever the
//   engine answers, and a table family's rules stay the table's call;
// - regression: a class the engine does not know is never counted as merged
//   away, which would make --fix delete it from the class list.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CANONICAL_MEMO } from "../../lib/canonical-cache.mjs";
import { buildCollapseKey, computeCollapseMerges, engineSupportsCollapse } from "../../lib/engine-collapse.mjs";
import { detectFamilyShorthand, mergeFixFamilyShorthand } from "../../lib/shorthand.mjs";
import { parseClassToken } from "../../lib/tokens.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let designSystem;

before(async () => {
    const require_ = createRequire(path.join(REPO_ROOT, "package.json"));
    const tailwindModule = await import(pathToFileURL(require_.resolve("tailwindcss")).href);
    const tailwind = tailwindModule.__unstable__loadDesignSystem ? tailwindModule : tailwindModule.default;
    const indexCssPath = require_.resolve("tailwindcss/index.css");
    designSystem = await tailwind.__unstable__loadDesignSystem(
        await fs.readFile(indexCssPath, "utf8"),
        { from: indexCssPath },
    );
});

// The table's answer for one class list: every shorthand target it reports.
// No merge-safety probe, so the engine path answers only from memo entries a
// test seeded; otherwise detectFamilyShorthand runs the vendored table alone.
function tableTargets(classes) {
    const found = new Map();
    detectFamilyShorthand(new Map([["|0", classes.map(parseClassToken)]]), "x.html", 1, 1, found, null);
    return [...found.values()].map((entry) => /by the '([^']+)' shorthand/.exec(entry.message)[1]);
}

const TABLE_PARITY_CASES = [
    ["px-4", "py-4"],
    ["ml-2", "mr-2"],
    ["mt-2", "mb-2"],
    ["mt-2", "mr-2", "mb-2", "ml-2"],
    ["-mt-2", "-mb-2"],
    ["gap-x-2", "gap-y-2"],
    ["border-t-2", "border-b-2"],
    ["rounded-tl-lg", "rounded-tr-lg"],
    ["inset-x-0", "inset-y-0"],
];

test("the bundled Tailwind supports the collapse option", () => {
    assert.strictEqual(engineSupportsCollapse(designSystem), true);
});

for (const classes of TABLE_PARITY_CASES) {
    test(`engine collapse matches the vendored table: ${classes.join(" ")}`, () => {
        const table = tableTargets(classes);
        assert.ok(table.length > 0, "the table itself reports a merge for this case");
        const { merges } = computeCollapseMerges(designSystem, classes);
        assert.strictEqual(merges.length, 1);
        assert.deepStrictEqual([...merges[0].sources].sort(), [...classes].sort());
        assert.ok(
            table.includes(merges[0].target),
            `engine target ${merges[0].target} is not among the table's ${table.join(", ")}`,
        );
    });
}

test("engine collapse never counts an unknown class as a merge source", () => {
    const { merges } = computeCollapseMerges(designSystem, ["card", "px-4", "py-4"]);
    assert.deepStrictEqual(merges, [{ target: "p-4", sources: ["px-4", "py-4"] }]);
});

// Stand-in engine answers, seeded straight into the memo the way
// resolvePendingCollapses records them ("_" = nothing to collapse), so these
// cases pin shorthand.mjs's precedence rules whatever the bundled engine does.
const SEEDED_COLLAPSES = [
    [["rounded-t-xl", "rounded-r-xl", "rounded-b-xl", "rounded-l-xl"], "_"],
    [["border-l", "border-r"], "_"],
    [["text-sm", "leading-6"], `${encodeURIComponent("text-sm/6")}=text-sm+leading-6`],
    [["rounded-t-md", "rounded-b-md"], "rounded-md=rounded-t-md+rounded-b-md"],
];

function seedCollapses() {
    for (const [utilities, value] of SEEDED_COLLAPSES) {
        CANONICAL_MEMO.set(buildCollapseKey(utilities), value);
    }
}

after(() => {
    for (const [utilities] of SEEDED_COLLAPSES) {
        CANONICAL_MEMO.delete(buildCollapseKey(utilities));
    }
});

// Regression: the reverted first cut let an engine answer replace the table for
// the whole group, and the corners fixture lost exactly these findings.
test("an engine answer never drops a finding the table makes", () => {
    seedCollapses();
    assert.deepStrictEqual(tableTargets(["rounded-t-xl", "rounded-r-xl", "rounded-b-xl", "rounded-l-xl"]), ["rounded-xl"]);
    assert.deepStrictEqual(tableTargets(["border-l", "border-r"]), ["border-x"]);
    const tokens = ["rounded-t-xl", "rounded-r-xl", "rounded-b-xl", "rounded-l-xl"];
    mergeFixFamilyShorthand(tokens);
    assert.deepStrictEqual(tokens, ["rounded-xl"]);
});

test("an engine merge the table misses is added on both the audit and fix side", () => {
    seedCollapses();
    assert.deepStrictEqual(tableTargets(["text-sm", "leading-6"]), ["text-sm/6"]);
    const tokens = ["text-sm", "leading-6"];
    assert.strictEqual(mergeFixFamilyShorthand(tokens), true);
    assert.deepStrictEqual(tokens, ["text-sm/6"]);
});

// The radius family has no t+b -> all rule on purpose (see the corners
// fixture); an engine collapse inside one table family must not override it.
test("an engine merge inside one table family stays the table's call", () => {
    seedCollapses();
    assert.deepStrictEqual(tableTargets(["rounded-t-md", "rounded-b-md"]), []);
    const tokens = ["rounded-t-md", "rounded-b-md"];
    assert.strictEqual(mergeFixFamilyShorthand(tokens), false);
});

// WHY: the real engine may pass an unknown class through, which would let the
// test above pass without the `known` filter. This stub engine drops it from
// its output, the shape in which a missing filter would hand "card" to --fix
// as a merge source.
test("engine collapse ignores an unknown class the engine drops", () => {
    const stub = {
        canonicalizeCandidates: (list) => {
            const kept = list.filter((utility) => utility !== "card");
            return kept.includes("px-4") && kept.includes("py-4")
                ? ["p-4", ...kept.filter((utility) => utility !== "px-4" && utility !== "py-4")]
                : kept;
        },
        candidatesToCss: (list) => list.map((utility) => (utility === "card" ? null : `.${utility}{}`)),
    };
    const { merges } = computeCollapseMerges(stub, ["card", "px-4", "py-4"]);
    assert.deepStrictEqual(merges, [{ target: "p-4", sources: ["px-4", "py-4"] }]);
});
