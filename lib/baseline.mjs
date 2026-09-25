// Per-file finding-count baseline (a "ratchet") for --baseline.
//
// WHY: a legacy codebase with hundreds of existing findings cannot switch on
// a CI gate that fails on every one of them, and a per-file ignore list is
// all-or-nothing: an ignored file can gain new findings forever. A count per
// file lets the gate land today instead. A file may keep the findings it
// already had, any new one fails the run, and a count that drops must be
// lowered in the baseline too, so the debt can only go down.
//
// Findings carry no stable identity (line numbers move with every edit), so
// the ratchet works on counts, not on individual findings: a file over its
// allowance reports all of its findings, because any of them may be the new one.

import fs from "node:fs/promises";
import path from "node:path";
import { MAX_SCANNED_FILE_BYTES } from "./scan-config.mjs";
import { resolveActionSafePath } from "./workspace.mjs";

const BASELINE_SCHEMA_VERSION = 1;

function normalizeBaselineKey(filePath) {
    return String(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}

// Parse and validate baseline JSON text into a Map of file -> allowed count.
// A malformed file is a configuration error, never "no baseline": silently
// treating it as empty would fail every legacy finding at once, and treating
// it as permissive would hide new ones.
function parseBaseline(text, label = "baseline") {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`normwinds: ${label} is not valid JSON.`);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`normwinds: ${label} must be a JSON object.`);
    }
    if (data.version !== BASELINE_SCHEMA_VERSION) {
        throw new Error(
            `normwinds: ${label} has unsupported version ${JSON.stringify(data.version)} (expected ${BASELINE_SCHEMA_VERSION}).`,
        );
    }
    const files = data.files;
    if (files === null || typeof files !== "object" || Array.isArray(files)) {
        throw new Error(`normwinds: ${label} must have a "files" object of path -> finding count.`);
    }
    const counts = new Map();
    for (const [filePath, count] of Object.entries(files)) {
        if (!Number.isInteger(count) || count < 0) {
            throw new Error(
                `normwinds: ${label} entry "${filePath}" must be a non-negative integer, received ${JSON.stringify(count)}.`,
            );
        }
        if (count > 0) {
            counts.set(normalizeBaselineKey(filePath), count);
        }
    }
    return counts;
}

// Stable, diff-friendly serialization: sorted paths, one entry per line.
function serializeBaseline(counts, ruleId) {
    const files = {};
    for (const filePath of [...counts.keys()].sort()) {
        files[filePath] = counts.get(filePath);
    }
    return `${JSON.stringify({ version: BASELINE_SCHEMA_VERSION, ruleId, files }, null, 2)}\n`;
}

function countFindingsByFile(findings) {
    const counts = new Map();
    for (const finding of findings) {
        const key = normalizeBaselineKey(finding.filePath);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

// Compare a scan against the baseline. Only files this run actually scanned
// are judged; an entry for a file outside the run's scope is left alone, and
// one for a file that no longer exists (goneFiles) is stale.
//
// Returns the findings to report: every finding of a file over its allowance,
// plus one note per stale entry, so a stale baseline fails the run through the
// ordinary findings path (exit 1, annotations) rather than a side channel.
function compareWithBaseline(findings, baselineCounts, { scannedFiles, goneFiles = new Set() }) {
    const current = countFindingsByFile(findings);
    const exceeded = [];
    const stale = [];
    const reportedFiles = new Set();
    let suppressed = 0;

    for (const [filePath, count] of current) {
        const allowed = baselineCounts.get(filePath) ?? 0;
        if (count > allowed) {
            exceeded.push({ filePath, count, allowed });
            reportedFiles.add(filePath);
        } else {
            suppressed += count;
        }
    }

    for (const [filePath, allowed] of baselineCounts) {
        const gone = goneFiles.has(filePath);
        if (!gone && !scannedFiles.has(filePath)) {
            continue;
        }
        const count = gone ? 0 : (current.get(filePath) ?? 0);
        if (count < allowed) {
            stale.push({ filePath, count, allowed, gone });
        }
    }

    const reported = findings.filter((finding) => reportedFiles.has(normalizeBaselineKey(finding.filePath)));
    for (const { filePath, count, allowed, gone } of stale) {
        const state = gone ? "the file no longer exists" : `only ${count} remain`;
        reported.push({
            filePath,
            line: 1,
            column: 1,
            message: `The baseline allows ${allowed} finding(s) here but ${state}; lower it with --update-baseline`,
            // Lets changed-line gating keep the note, which sits on line 1
            // (or in a deleted file) rather than on the line that changed.
            baselineNote: true,
        });
    }
    reported.sort(
        (a, b) =>
            a.filePath.localeCompare(b.filePath) ||
            a.line - b.line ||
            a.column - b.column ||
            a.message.localeCompare(b.message),
    );

    return { findings: reported, suppressed, exceeded, stale };
}

// Plan a --update-baseline write. Regeneration may only lower or remove
// counts: raising one would quietly accept a new finding, which is exactly
// what the ratchet exists to stop. A baseline that does not exist yet is the
// one-time adoption step, so every current count is taken as-is.
function planBaselineUpdate(findings, baselineCounts, { exists, scannedFiles, goneFiles = new Set() }) {
    const current = countFindingsByFile(findings);
    const next = new Map(baselineCounts);
    const raised = [];

    for (const filePath of goneFiles) {
        next.delete(filePath);
    }
    for (const filePath of scannedFiles) {
        const count = current.get(filePath) ?? 0;
        const allowed = baselineCounts.get(filePath) ?? 0;
        if (exists && count > allowed) {
            raised.push({ filePath, count, allowed });
        }
        if (count > 0) {
            next.set(filePath, count);
        } else {
            next.delete(filePath);
        }
    }

    return raised.length > 0 ? { raised, next: null } : { raised, next };
}

async function readBaselineFile(baselinePath) {
    let stats;
    try {
        stats = await fs.stat(baselinePath);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return { exists: false, counts: new Map() };
        }
        throw error;
    }
    if (!stats.isFile()) {
        throw new Error(`normwinds: --baseline "${baselinePath}" is not a regular file.`);
    }
    if (stats.size > MAX_SCANNED_FILE_BYTES) {
        throw new Error(
            `normwinds: --baseline "${baselinePath}" exceeds the ${MAX_SCANNED_FILE_BYTES}-byte limit (${stats.size} bytes).`,
        );
    }
    // In Action mode the baseline must live in the checkout like every other
    // input path; a symlink out of the workspace is refused, not followed.
    const text = await fs.readFile(await resolveActionSafePath(baselinePath, "--baseline"), "utf8");
    return { exists: true, counts: parseBaseline(text, `--baseline "${baselinePath}"`) };
}

// Baseline entries for files that were not scanned and are no longer on disk.
async function findGoneFiles(baselineCounts, scannedFiles) {
    const gone = new Set();
    for (const filePath of baselineCounts.keys()) {
        if (scannedFiles.has(filePath)) {
            continue;
        }
        try {
            await fs.access(path.resolve(filePath));
        } catch {
            gone.add(filePath);
        }
    }
    return gone;
}

function describeFileCounts(entries) {
    return entries
        .map(({ filePath, count, allowed }) => `  - ${filePath}: ${count} finding(s), baseline allows ${allowed}`)
        .join("\n");
}

// The CLI's single entry point: judge (or, with update, rewrite) the baseline
// for one scan. `scannedPaths` are the run's files, relative to the working
// directory the same way findings are. Diagnostics go to stderr so a --json or
// --reporter sarif stdout stays machine-readable.
async function applyBaseline({ baselinePath, update, findings, scannedPaths, scanComplete, ruleId }) {
    const { exists, counts } = await readBaselineFile(baselinePath);
    const scannedFiles = new Set(scannedPaths.map(normalizeBaselineKey));
    const goneFiles = await findGoneFiles(counts, scannedFiles);
    const summary = { path: baselinePath, suppressed: 0, exceeded: 0, stale: 0, updated: false };

    if (update) {
        // A skipped or unreadable file would record zero findings and drop its
        // entry, so an incomplete scan never rewrites the baseline.
        if (!scanComplete) {
            console.error("normwinds: not updating the baseline because the scan was incomplete (see the audit summary above).");
        } else {
            const plan = planBaselineUpdate(findings, counts, { exists, scannedFiles, goneFiles });
            if (plan.next) {
                await fs.writeFile(baselinePath, serializeBaseline(plan.next, ruleId), "utf8");
                const total = [...plan.next.values()].reduce((sum, count) => sum + count, 0);
                console.error(
                    `normwinds: ${exists ? "updated" : "wrote"} baseline ${baselinePath} (${total} finding(s) across ${plan.next.size} file(s)).`,
                );
                summary.updated = true;
                summary.suppressed = findings.length;
                return { findings: [], summary };
            }
            console.error(
                `normwinds: refusing to raise the baseline for ${plan.raised.length} file(s); --update-baseline only lowers counts. Fix the new findings, or edit ${baselinePath} by hand if the increase is intended.\n${describeFileCounts(plan.raised)}`,
            );
        }
    }

    const result = compareWithBaseline(findings, counts, { scannedFiles, goneFiles });
    summary.suppressed = result.suppressed;
    summary.exceeded = result.exceeded.length;
    summary.stale = result.stale.length;
    console.error(
        `normwinds: baseline ${baselinePath}: ${result.suppressed} existing finding(s) held by the baseline, ${result.exceeded.length} file(s) over it, ${result.stale.length} entr${result.stale.length === 1 ? "y" : "ies"} to lower.`,
    );
    if (result.exceeded.length > 0) {
        console.error(describeFileCounts(result.exceeded));
    }
    return { findings: result.findings, summary };
}

export {
    BASELINE_SCHEMA_VERSION,
    applyBaseline,
    compareWithBaseline,
    parseBaseline,
    planBaselineUpdate,
    readBaselineFile,
    serializeBaseline,
};
