// Holds audit finding F-01: a w-X h-X pair must only become size-X when
// Tailwind's size-X sets exactly width:X and height:X. `w-screen h-screen`
// used to become `size-screen`, a class Tailwind does not define, so --fix
// silently removed both declarations.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as tailwind from "tailwindcss";

import { SIZE_MERGE_UNSUPPORTED_VALUES } from "../../lib/shorthand.mjs";

const require = createRequire(import.meta.url);

function declarations(designSystem, className) {
    const css = designSystem.candidatesToCss([className])[0];
    if (!css) {
        return null;
    }
    return [...String(css).matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)]
        .map((match) => `${match[1]}:${match[2].trim()}`)
        .sort()
        .join(";");
}

test("every value shared by w- and h- either has an equal size- or is excluded", async () => {
    const cssPath = require.resolve("tailwindcss/index.css");
    const designSystem = await tailwind.__unstable__loadDesignSystem(await fs.readFile(cssPath, "utf8"), { from: cssPath });
    const classes = designSystem.getClassList().map(([name]) => name);
    const widths = new Set(classes.filter((name) => name.startsWith("w-")).map((name) => name.slice(2)));
    const heights = new Set(classes.filter((name) => name.startsWith("h-")).map((name) => name.slice(2)));
    const shared = [...widths].filter((value) => heights.has(value));
    assert.ok(shared.length > 20, `expected many shared w-/h- values, got ${shared.length}`);

    const missing = [];
    for (const value of shared) {
        const expected = [declarations(designSystem, `w-${value}`), declarations(designSystem, `h-${value}`)]
            .join(";").split(";").sort().join(";");
        const sizeMatches = declarations(designSystem, `size-${value}`) === expected;
        if (!sizeMatches && !SIZE_MERGE_UNSUPPORTED_VALUES.has(value)) {
            missing.push(value);
        }
        if (sizeMatches && SIZE_MERGE_UNSUPPORTED_VALUES.has(value)) {
            missing.push(`${value} (excluded but size- now matches; drop it from the set)`);
        }
    }
    assert.deepEqual(missing, [], `size- merge values out of step with Tailwind: ${missing.join(", ")}`);
});

test("screen is excluded", () => {
    assert.ok(SIZE_MERGE_UNSUPPORTED_VALUES.has("screen"));
});
