// WHY: moved out of scripts/test-units.mjs (2026-09-05), see test/lib/tokens.test.mjs
// for the full rationale. Behavior preserved exactly.
import test from "node:test";
import assert from "node:assert/strict";

import { globPatternToRegExp, hasGlobSyntax } from "../../lib/glob.mjs";

test("glob syntax is detected", () => {
    assert.ok(hasGlobSyntax("src/**/*.vue"));
});

test("a plain path is not a glob", () => {
    assert.ok(!hasGlobSyntax("src/App.vue"));
});

test("the documented glob syntax matches", () => {
    assert.ok(globPatternToRegExp("src/**/*.vue").test("src/a/b/C.vue")); // ** spans directories
    assert.ok(globPatternToRegExp("src/**/*.vue").test("src/C.vue")); // ...and zero of them
    assert.ok(globPatternToRegExp("*.vue").test("a/b/C.vue")); // a bare pattern matches at any depth
    assert.ok(globPatternToRegExp("*.{vue,tsx}").test("a/B.tsx")); // brace alternation
});

test("a rooted pattern does not match elsewhere", () => {
    assert.ok(!globPatternToRegExp("src/*.vue").test("other/C.vue"));
});

test("brace alternation excludes others", () => {
    assert.ok(!globPatternToRegExp("*.{vue,tsx}").test("a/B.ts"));
});
