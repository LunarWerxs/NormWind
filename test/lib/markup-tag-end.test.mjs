// Holds audit finding F-16: Svelte/Astro handlers are unquoted `{...}`
// expressions; the `>` of `=>` inside one used to end the tag, so a class
// attribute after the handler was never scanned.
import test from "node:test";
import assert from "node:assert/strict";

import { findMarkupTagEnd } from "../../lib/text.mjs";

test("a > inside an unquoted {expression} does not end the tag", () => {
    const source = `<button onclick={() => go(">")} class="px-2 py-2">x</button>`;
    assert.equal(findMarkupTagEnd(source, 0), source.indexOf(">x<"));
});

test("a template literal inside braces is skipped", () => {
    const source = "<div title={`a>b ${c}`} class=\"p-2\">";
    assert.equal(findMarkupTagEnd(source, 0), source.length - 1);
});

test("a quoted > still does not end the tag, and a plain tag ends at its >", () => {
    assert.equal(findMarkupTagEnd(`<div title="a>b" class="p-2">`, 0), 28);
    assert.equal(findMarkupTagEnd(`<div class="p-2">`, 0), 16);
});
