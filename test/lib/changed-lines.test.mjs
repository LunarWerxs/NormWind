// WHY: --diff-base and the Action's changed-lines-only input gate CI on the
// lines this module reports. A wrong line number either fails a PR on old
// debt or lets a new finding through, so the hunk arithmetic is pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
    assertSafeDiffBase,
    buildChangedLineLookup,
    isChangedLine,
    parseChangedLines,
    partitionFindingsByChangedLines,
} from "../../lib/changed-lines.mjs";

const DIFF = [
    "diff --git a/src/Card.vue b/src/Card.vue",
    "index 1111111..2222222 100644",
    "--- a/src/Card.vue",
    "+++ b/src/Card.vue",
    "@@ -3 +3 @@",
    "-  <div class=\"p-4\">",
    "+  <div class=\"px-4 py-4\">",
    "@@ -10,2 +9,0 @@",
    "-gone",
    "-gone",
    "@@ -20,0 +19,2 @@",
    "+++ added line whose text starts with two plus signs",
    "+second",
    "diff --git a/src/Old.vue b/src/Old.vue",
    "deleted file mode 100644",
    "--- a/src/Old.vue",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
    "diff --git a/src/sp ace\"q.vue b/src/sp ace\"q.vue",
    "--- \"a/src/sp ace\\\"q.vue\"",
    "+++ \"b/src/sp ace\\\"q.vue\"",
    "@@ -0,0 +1 @@",
    "+x",
    "",
].join("\n");

test("changed lines: new-side hunk lines, pure deletions gate nothing", () => {
    const changed = parseChangedLines(DIFF);
    assert.deepStrictEqual([...changed.get("src/Card.vue")].sort((a, b) => a - b), [3, 19, 20]);
});

test("changed lines: an added '+++' line is content, not a file header", () => {
    const changed = parseChangedLines(DIFF);
    assert.deepStrictEqual([...changed.keys()].sort(), ["src/Card.vue", "src/sp ace\"q.vue"]);
});

test("changed lines: lookup by absolute path, untracked files count in full", () => {
    const root = path.resolve("repo-root");
    const lookup = buildChangedLineLookup(root, parseChangedLines(DIFF), ["src/New.vue"]);
    assert.ok(isChangedLine(lookup, path.join(root, "src", "Card.vue"), 19));
    assert.ok(!isChangedLine(lookup, path.join(root, "src", "Card.vue"), 9));
    assert.ok(isChangedLine(lookup, path.join(root, "src", "New.vue"), 999));
    assert.ok(!isChangedLine(lookup, path.join(root, "src", "Other.vue"), 1));
});

test("changed lines: a --baseline note to lower a count is always gated", () => {
    const root = path.resolve("repo-root");
    const lookup = buildChangedLineLookup(root, parseChangedLines(DIFF), []);
    const onChanged = { filePath: "src/Card.vue", line: 3 };
    const onUnchanged = { filePath: "src/Card.vue", line: 9 };
    const note = { filePath: "src/Old.vue", line: 1, baselineNote: true };
    const { changed, unchanged } = partitionFindingsByChangedLines(
        [onChanged, onUnchanged, note],
        lookup,
        (finding) => path.join(root, finding.filePath),
    );
    assert.deepStrictEqual(changed, [onChanged, note]);
    assert.deepStrictEqual(unchanged, [onUnchanged]);
});

test("diff base refuses option-shaped and range refs", () => {
    assert.strictEqual(assertSafeDiffBase("origin/main"), "origin/main");
    for (const bad of ["--output=x", "-p", "main..HEAD", "a b", ""]) {
        assert.throws(() => assertSafeDiffBase(bad));
    }
});
