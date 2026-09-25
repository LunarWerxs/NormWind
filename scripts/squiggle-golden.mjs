/**
 * Squiggle golden renderer for the regression fixtures.
 *
 * WHY: expected.json pins findings as line/column numbers and the
 * expected.fixed.* / expected.fixall.* files pin the rewrite, so a reviewer
 * has to cross-reference three files to see where a rule fired and what it
 * produced. This renders all of it as one readable text file per fixture:
 * the source with `~~~` under every class a finding names, a
 * `!!! <ruleId>: <message>` line under the line the finding is reported on,
 * then the --fix and --fixall output. A rule change becomes a plain text diff.
 *
 * Idea from microsoft/TypeScript tools/customlint/plugin_test.go (Apache-2.0);
 * written fresh for NormWind, no code copied.
 */

const FIX_HEADER = "=== FIXED (--fix) ===";
const FIXALL_HEADER = "=== FIXED (--fixall) ===";

// Characters that can sit on either side of a class token inside a class
// string, attribute, template literal, or builder-call argument.
const TOKEN_BOUNDARY = /[\s"'`{},]/;

function toLf(text) {
    return String(text ?? "").replace(/\r\n/g, "\n");
}

// Both message shapes quote the classes first: "Classnames 'a, b' could be
// replaced by ..." and "The class 'a' can be written as ...".
function flaggedTokens(message) {
    const match = /'([^']+)'/.exec(String(message ?? ""));
    if (!match) {
        return [];
    }
    return match[1].split(/,\s*/).filter(Boolean);
}

function isBoundary(text, index) {
    return index < 0 || index >= text.length || TOKEN_BOUNDARY.test(text[index]);
}

// First whole-token occurrence at or after `from`. Searching forward (not
// only on the reported line) is what places squiggles correctly when a class
// string wraps onto later lines.
function findToken(text, token, from) {
    let index = text.indexOf(token, from);
    while (index !== -1) {
        if (isBoundary(text, index - 1) && isBoundary(text, index + token.length)) {
            return index;
        }
        index = text.indexOf(token, index + 1);
    }
    return -1;
}

function lineStartsOf(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "\n") {
            starts.push(i + 1);
        }
    }
    return starts;
}

function lineIndexAt(lineStarts, offset) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lineStarts[mid] <= offset) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
}

function markSpan(marks, lineStarts, offset, length) {
    const lineIndex = lineIndexAt(lineStarts, offset);
    const column = offset - lineStarts[lineIndex];
    const columns = marks.get(lineIndex) ?? new Set();
    for (let i = 0; i < length; i += 1) {
        columns.add(column + i);
    }
    marks.set(lineIndex, columns);
}

// Tabs in the source are echoed so the squiggles stay aligned in any editor.
function squiggleLine(sourceLine, columns) {
    const last = Math.max(...columns);
    let out = "";
    for (let i = 0; i <= last; i += 1) {
        if (columns.has(i)) {
            out += "~";
        } else {
            out += sourceLine[i] === "\t" ? "\t" : " ";
        }
    }
    return out;
}

/**
 * @param {object} options
 * @param {string} options.fileName  fixture input name, e.g. "input.vue"
 * @param {string} options.source    input text before any fix
 * @param {string} options.ruleId    top-level ruleId of the --json payload
 * @param {Array<{line: number, column: number, message: string}>} options.findings
 * @param {string|null} options.fixed   file text after --fix
 * @param {string|null} options.fixall  file text after --fixall
 * @returns {string}
 */
export function renderSquiggleGolden({ fileName, source, ruleId, findings, fixed, fixall }) {
    const text = toLf(source);
    const lines = text.split("\n");
    const lineStarts = lineStartsOf(text);
    const marks = new Map();
    const notes = new Map();
    const list = Array.isArray(findings) ? findings : [];

    for (const finding of list) {
        const lineIndex = Math.min(Math.max((finding.line ?? 1) - 1, 0), lines.length - 1);
        const anchor = Math.min(
            lineStarts[lineIndex] + Math.max((finding.column ?? 1) - 1, 0),
            text.length,
        );
        let placed = false;
        for (const token of flaggedTokens(finding.message)) {
            const at = findToken(text, token, anchor);
            if (at !== -1) {
                markSpan(marks, lineStarts, at, token.length);
                placed = true;
            }
        }
        if (!placed) {
            // Unlocatable token: mark the reported column so the finding still shows.
            markSpan(marks, lineStarts, anchor, 1);
        }
        const lineNotes = notes.get(lineIndex) ?? [];
        lineNotes.push(`!!! ${ruleId}: ${finding.message}`);
        notes.set(lineIndex, lineNotes);
    }

    const count = list.length;
    const out = [`==== ${fileName} (${count} finding${count === 1 ? "" : "s"}) ====`];
    lines.forEach((line, index) => {
        out.push(line);
        if (marks.has(index)) {
            out.push(squiggleLine(line, marks.get(index)));
        }
        for (const note of notes.get(index) ?? []) {
            out.push(note);
        }
    });

    const fixedText = fixed === null || fixed === undefined ? null : toLf(fixed);
    const fixallText = fixall === null || fixall === undefined ? null : toLf(fixall);
    out.push(FIX_HEADER);
    out.push(fixedText === null ? "(no output)" : fixedText === text ? "(unchanged)" : fixedText);
    out.push(FIXALL_HEADER);
    out.push(
        fixallText === null
            ? "(no output)"
            : fixallText === fixedText
              ? "(same as --fix)"
              : fixallText === text
                ? "(unchanged)"
                : fixallText,
    );

    return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
