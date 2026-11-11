// Holds audit finding F-20: a rewrite used to re-join every token of a class
// string with single spaces, collapsing a wrapped multi-line class list onto
// one line. The rewritten tokens now reuse the string's own separators.
import test from "node:test";
import assert from "node:assert/strict";

import { rejoinPreservingLayout } from "../../lib/fix.mjs";

test("in-place replacements keep every separator", () => {
    const middle = "flex\n      w-[16px]   items-center";
    assert.equal(rejoinPreservingLayout(middle, ["flex", "w-4", "items-center"]), "flex\n      w-4   items-center");
});

test("a merge keeps the line structure of a wrapped list", () => {
    const middle = "px-2\n       py-2 text-red-500\n       font-bold";
    assert.equal(
        rejoinPreservingLayout(middle, ["p-2", "text-red-500", "font-bold"]),
        "p-2\n       text-red-500\n       font-bold",
    );
});

test("dropping the last token on a line keeps the line break", () => {
    const middle = "ml-2 mr-2\n    flex";
    assert.equal(rejoinPreservingLayout(middle, ["mx-2", "flex"]), "mx-2\n    flex");
});

test("a token alone on its line disappears with its line", () => {
    const middle = "mt-4\n    mb-4\n    flex";
    assert.equal(rejoinPreservingLayout(middle, ["my-4", "flex"]), "my-4\n    flex");
});

test("a single-line list is unchanged in shape", () => {
    assert.equal(rejoinPreservingLayout("px-4 py-4 rounded", ["p-4", "rounded"]), "p-4 rounded");
    assert.equal(rejoinPreservingLayout("w-6 h-6", ["size-6"]), "size-6");
});
