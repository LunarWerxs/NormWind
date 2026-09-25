// Changed-line gating: which lines a branch added or edited relative to a
// base ref, read from `git diff --unified=0`. WHY: turning a strict audit on
// in an existing codebase floods CI with findings nobody touched. Gating only
// on the lines a change adds lets a repo adopt NormWind at full strictness on
// day one, while the full report still records the older debt.

import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 2 * 60 * 1_000;

// Marks a file every line of which counts as changed (a file git does not
// track yet). Kept distinct from an empty Set, which means "no added lines".
export const ALL_LINES = "all-lines";

// A ref is handed to git as an argument, so refuse anything git could read as
// an option or that is not plain ref syntax (branch, tag, SHA, origin/main,
// HEAD~3, main@{1}).
const SAFE_REF = /^[A-Za-z0-9._/@{}~^-]+$/;

export function assertSafeDiffBase(ref) {
    const value = String(ref ?? "");
    if (!value || value.startsWith("-") || value.includes("..") || !SAFE_REF.test(value)) {
        throw new Error(`invalid diff base "${value}": pass a branch, tag or commit (e.g. origin/main).`);
    }
    return value;
}

// git C-quotes a path holding a double quote, backslash or control character
// ("a\"b.vue", octal escapes for raw bytes). Undo that so the path matches the
// file on disk.
function unquoteGitPath(raw) {
    if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
        return raw;
    }
    const body = raw.slice(1, -1);
    const bytes = [];
    const simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };
    for (let i = 0; i < body.length; i += 1) {
        const codePoint = body.codePointAt(i);
        if (codePoint !== 92) {
            bytes.push(...Buffer.from(String.fromCodePoint(codePoint), "utf8"));
            i += codePoint > 0xffff ? 1 : 0;
            continue;
        }
        const next = body[i + 1];
        if (/[0-7]/.test(next ?? "")) {
            bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
            i += 3;
        } else if (next !== undefined && Object.hasOwn(simple, next)) {
            bytes.push(simple[next]);
            i += 1;
        } else {
            bytes.push(92);
        }
    }
    return Buffer.from(bytes).toString("utf8");
}

// Parses `git diff --unified=0` output into Map<repo-relative path, Set<line>>
// of the NEW-side line numbers each hunk adds or edits. A pure deletion hunk
// (`+N,0`) adds no line, so it gates nothing. Deleted files (`+++ /dev/null`)
// are left out. `+++ ` is read only in a file header, never inside a hunk,
// where it is an added line whose own text starts with "++ ".
export function parseChangedLines(diffText) {
    const changed = new Map();
    let current = null;
    let inHeader = false;
    for (const line of String(diffText ?? "").split(/\r?\n/)) {
        if (line.startsWith("diff --git ")) {
            inHeader = true;
            current = null;
            continue;
        }
        if (inHeader && line.startsWith("+++ ")) {
            const target = unquoteGitPath(line.slice(4).trimEnd());
            if (target === "/dev/null") {
                current = null;
                continue;
            }
            const relative = target.startsWith("b/") ? target.slice(2) : target;
            current = changed.get(relative) ?? new Set();
            changed.set(relative, current);
            continue;
        }
        if (!current || !line.startsWith("@@")) {
            continue;
        }
        inHeader = false;
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!match) {
            continue;
        }
        const start = Number.parseInt(match[1], 10);
        const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
        for (let offset = 0; offset < count; offset += 1) {
            current.add(start + offset);
        }
    }
    return changed;
}

// Windows paths compare case-insensitively; everything else byte-for-byte.
function pathKey(absolutePath) {
    const resolved = path.resolve(absolutePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function git(args, cwd) {
    try {
        const { stdout } = await execFileAsync("git", args, {
            cwd,
            maxBuffer: GIT_MAX_BUFFER_BYTES,
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
        });
        return stdout;
    } catch (error) {
        const detail = String(error?.stderr ?? "").trim() || error?.message || String(error);
        throw new Error(`git ${args[0]} failed: ${detail}`);
    }
}

// Reads the lines changed between the merge base of `baseRef` and HEAD and the
// working tree, the same span a pull request shows. Files git does not track
// yet count as changed in full. Returns a lookup keyed by absolute path.
export async function readChangedLines(baseRef, { cwd = process.cwd() } = {}) {
    const ref = assertSafeDiffBase(baseRef);
    const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
    const mergeBase = (await git(["merge-base", ref, "HEAD"], root)).trim();
    const diff = await git(
        [
            "-c",
            "core.quotepath=off",
            "diff",
            "--unified=0",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            mergeBase,
            "--",
        ],
        root,
    );
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], root);
    return buildChangedLineLookup(root, parseChangedLines(diff), untracked.split("\0").filter(Boolean));
}

// Keys parsed diff lines and untracked files by absolute path, so a finding
// reported relative to any working directory inside the repo still matches.
export function buildChangedLineLookup(root, changedLines, untrackedFiles = []) {
    const lookup = new Map();
    for (const [relative, lines] of changedLines) {
        lookup.set(pathKey(path.join(root, relative)), lines);
    }
    for (const relative of untrackedFiles) {
        lookup.set(pathKey(path.join(root, relative)), ALL_LINES);
    }
    return lookup;
}

export function isChangedLine(lookup, absolutePath, line) {
    const lines = lookup.get(pathKey(absolutePath));
    if (lines === ALL_LINES) {
        return true;
    }
    return lines instanceof Set && lines.has(line);
}

// Splits findings into those on changed lines (gated) and the rest (reported
// only in the full log). `resolvePath` maps a finding to its absolute path.
export function partitionFindingsByChangedLines(findings, lookup, resolvePath) {
    const changed = [];
    const unchanged = [];
    for (const finding of findings) {
        (isChangedLine(lookup, resolvePath(finding), finding.line) ? changed : unchanged).push(finding);
    }
    return { changed, unchanged };
}
