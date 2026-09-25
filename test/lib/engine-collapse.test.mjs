// WHY: shorthand merges now come from Tailwind's own collapse
// (lib/engine-collapse.mjs) and the vendored eslint-plugin-tailwindcss table is
// only the fallback. These tests pin the seam between the two against the real
// bundled engine:
// - contract: for the merges the table has always made, the engine proposes the
//   same shorthand from the same sources, so switching engines changes no
//   existing finding (a Tailwind upgrade that stops collapsing one fails here);
// - regression: a class the engine does not know is never counted as merged
//   away, which would make --fix delete it from the class list.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeCollapseMerges, engineSupportsCollapse } from "../../lib/engine-collapse.mjs";
import { detectFamilyShorthand } from "../../lib/shorthand.mjs";
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
// No merge-safety probe and an empty memo, so the engine path has no answer
// and detectFamilyShorthand runs the vendored table alone.
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
