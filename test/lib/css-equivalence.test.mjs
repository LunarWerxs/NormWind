// WHY: moved out of scripts/test-units.mjs (2026-09-05), see test/lib/tokens.test.mjs
// for the full rationale. This is the guard that decides whether a shorthand
// merge is allowed to be applied, so it is worth asserting against the actual
// Tailwind design system rather than a fixture of its output - hence the
// `before` hook that loads the real engine once for the whole file.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { winningDeclarations } from "../../lib/css.mjs";

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

function rendersIdentically(beforeClasses, afterClasses) {
    const a = winningDeclarations(designSystem, beforeClasses);
    const b = winningDeclarations(designSystem, afterClasses);
    if (!a || !b || a.size !== b.size) {
        return false;
    }
    for (const [property, value] of a) {
        if (b.get(property) !== value) {
            return false;
        }
    }
    return true;
}

const EQUIVALENCE_CASES = [
    ["px-4 py-4 collapses to p-4", ["px-4", "py-4"], ["p-4"], true],
    ["w-6 h-6 collapses to size-6", ["w-6", "h-6"], ["size-6"], true],
    ["four sides collapse to the axes", ["border-8", "border-t-4", "border-r-4", "border-b-4", "border-l-4"], ["border-8", "border-y-4", "border-x-4"], true],
    ["a border color does not block a width merge", ["border-red-500", "border-t-4", "border-r-4", "border-b-4", "border-l-4"], ["border-red-500", "border-4"], true],
    ["truncate is exactly its three parts", ["overflow-hidden", "text-ellipsis", "whitespace-nowrap"], ["truncate"], true],
    // The regressions that motivated the guard. Each of these WAS applied by
    // --fix and each silently changed the rendered box.
    ["a wider border-all must block the four-sides merge", ["border-8", "border-t-4", "border-r-4", "border-b-4", "border-l-4"], ["border-8", "border-4"], false],
    ["a wider mx must block the l/r merge", ["mx-8", "ml-2", "mr-2"], ["mx-8", "mx-2"], false],
    ["a wider size must block the w/h merge", ["size-8", "w-4", "h-4"], ["size-8", "size-4"], false],
    ["a shadowed duplicate width must block the merge", ["w-4", "w-6", "h-6"], ["w-4", "size-6"], false],
];

for (const [label, beforeClasses, afterClasses, expected] of EQUIVALENCE_CASES) {
    test(`css equivalence: ${label}`, () => {
        assert.strictEqual(rendersIdentically(beforeClasses, afterClasses), expected);
    });
}
