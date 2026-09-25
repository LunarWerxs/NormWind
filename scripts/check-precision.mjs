#!/usr/bin/env node
/**
 * NormWind rewrite-precision gate.
 *
 * WHY: a false positive is a bug in a rewrite rule, but the per-fixture
 * regression harness only proves that each fixture still matches its own
 * baseline; nothing measured how often the rules are wrong overall. This
 * script runs a labelled corpus (test/precision/corpus.json) of must-rewrite
 * and must-not-rewrite class strings through the real CLI and fails when the
 * aggregate precision, recall or false-positive rate crosses a fixed floor,
 * so a noisy rule fails its own gate before it reaches anyone's codebase.
 * Idea adapted from the quality gate in thedaviddias/Front-End-Checklist
 * (no code copied).
 *
 * Two passes are scored, each against the same labels:
 *
 *   detection:  node bin/normwind.mjs --json
 *               a case is predicted positive when it has any finding.
 *
 *   rewrite:    node bin/normwind.mjs --fixall --json
 *               a 'rewrite' case is a true positive only when the rewritten
 *               class string equals its 'to'; a different rewrite counts as
 *               a false positive (it changed the markup wrongly) and as a
 *               miss. A 'keep' case that changes at all is a false positive.
 *
 * Modes:
 *   --json       emit a machine-readable summary to stdout.
 *
 * Exit codes:
 *   0 -> every metric is within its floor
 *   1 -> at least one metric crossed its floor
 *   2 -> harness failure (bad corpus, CLI error, unparseable output)
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NORMWIND_BIN = path.join(REPO_ROOT, "bin", "normwind.mjs");
const CORPUS_PATH = path.join(REPO_ROOT, "test", "precision", "corpus.json");
const NODE_BIN = process.execPath;
const LABELS = new Set(["rewrite", "keep"]);

// Floors match the ones the upstream idea ships with. Rewrites are held to the
// same bar as detection: a wrong rewrite on disk costs more than a wrong report.
export const FLOORS = Object.freeze({ precision: 0.9, recall: 0.85, falsePositiveRate: 0.1 });

// A metric with a zero denominator is null, never 0 or 1: an empty corpus (or
// one with no 'keep' cases) must fail the gate rather than pass it vacuously.
function ratio(numerator, denominator) {
    return denominator === 0 ? null : numerator / denominator;
}

export function scoreConfusion({ tp, fp, fn, tn }) {
    return {
        precision: ratio(tp, tp + fp),
        recall: ratio(tp, tp + fn),
        falsePositiveRate: ratio(fp, fp + tn),
    };
}

// Returns one message per metric that is missing or outside its floor.
export function gateFailures(pass, metrics, floors = FLOORS) {
    const failures = [];
    const checks = [
        ["precision", (v) => v >= floors.precision, `>= ${floors.precision}`],
        ["recall", (v) => v >= floors.recall, `>= ${floors.recall}`],
        ["falsePositiveRate", (v) => v <= floors.falsePositiveRate, `<= ${floors.falsePositiveRate}`],
    ];
    for (const [name, withinFloor, bound] of checks) {
        const value = metrics[name];
        if (value === null || Number.isNaN(value)) {
            failures.push(`${pass} ${name}: not measurable (no cases on one side of the label), needs ${bound}`);
        } else if (!withinFloor(value)) {
            failures.push(`${pass} ${name}: ${formatRatio(value)} is outside the floor ${bound}`);
        }
    }
    return failures;
}

function formatRatio(value) {
    return value === null ? "n/a" : value.toFixed(3);
}

function normalizeClassList(value) {
    return value.trim().split(/\s+/).filter(Boolean).join(" ");
}

function validateCorpus(corpus) {
    const cases = Array.isArray(corpus?.cases) ? corpus.cases : null;
    if (!cases || cases.length === 0) {
        throw new Error("corpus has no cases");
    }
    const seen = new Set();
    for (const entry of cases) {
        if (typeof entry.id !== "string" || !/^[a-z0-9-]+$/.test(entry.id)) {
            throw new Error(`case id must be lowercase kebab-case: ${JSON.stringify(entry.id)}`);
        }
        if (seen.has(entry.id)) {
            throw new Error(`duplicate case id: ${entry.id}`);
        }
        seen.add(entry.id);
        if (!LABELS.has(entry.label)) {
            throw new Error(`${entry.id}: label must be 'rewrite' or 'keep'`);
        }
        if (typeof entry.class !== "string" || entry.class.includes('"')) {
            throw new Error(`${entry.id}: class must be a string without double quotes`);
        }
        if (entry.label === "rewrite" && typeof entry.to !== "string") {
            throw new Error(`${entry.id}: a 'rewrite' case needs a 'to'`);
        }
    }
    return cases;
}

function caseFileName(entry) {
    return `${entry.id}.vue`;
}

function caseMarkup(entry) {
    return `<template>\n    <div class="${entry.class}"></div>\n</template>\n`;
}

async function writeCases(cases) {
    const dir = path.join(os.tmpdir(), `normwind-precision-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    for (const entry of cases) {
        await fs.writeFile(path.join(dir, caseFileName(entry)), caseMarkup(entry), "utf8");
    }
    return dir;
}

async function runNormwind(args, cwd) {
    try {
        const { stdout, stderr } = await execFileAsync(NODE_BIN, [NORMWIND_BIN, ...args], {
            cwd,
            env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
            maxBuffer: 32 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
    } catch (err) {
        if (typeof err.code === "number") {
            return { exitCode: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
        }
        throw err;
    }
}

function parseCliJson(stdout, label) {
    const trimmed = stdout.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
        throw new Error(`${label}: CLI did not emit JSON`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
}

// Exit 0/1 are the audit contract (clean / findings); anything else means the
// run itself failed, and a metric computed from a failed run would be a lie.
function assertAuditExit(result, label) {
    if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`${label}: CLI exited ${result.exitCode}\n${result.stderr.trim()}`);
    }
}

async function detectFlaggedCases(cases) {
    const dir = await writeCases(cases);
    try {
        const result = await runNormwind(["--json"], dir);
        assertAuditExit(result, "detection");
        const payload = parseCliJson(result.stdout, "detection");
        const flagged = new Set();
        for (const finding of payload.findings ?? []) {
            flagged.add(path.basename(String(finding.filePath).replace(/\\/g, "/")));
        }
        return flagged;
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function rewriteCases(cases) {
    const dir = await writeCases(cases);
    try {
        const result = await runNormwind(["--fixall", "--json"], dir);
        assertAuditExit(result, "rewrite");
        const rewritten = new Map();
        for (const entry of cases) {
            const text = await fs.readFile(path.join(dir, caseFileName(entry)), "utf8");
            const match = /class="([^"]*)"/.exec(text);
            if (!match) {
                throw new Error(`rewrite: ${entry.id} lost its class attribute:\n${text}`);
            }
            rewritten.set(entry.id, normalizeClassList(match[1]));
        }
        return rewritten;
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function scoreDetection(cases, flagged) {
    const counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
    const misses = [];
    for (const entry of cases) {
        const isFlagged = flagged.has(caseFileName(entry));
        if (entry.label === "rewrite") {
            counts[isFlagged ? "tp" : "fn"] += 1;
            if (!isFlagged) misses.push(`${entry.id}: not flagged ("${entry.class}")`);
        } else {
            counts[isFlagged ? "fp" : "tn"] += 1;
            if (isFlagged) misses.push(`${entry.id}: flagged but labelled keep ("${entry.class}")`);
        }
    }
    return { counts, misses };
}

function scoreRewrite(cases, rewritten) {
    const counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
    const misses = [];
    for (const entry of cases) {
        const before = normalizeClassList(entry.class);
        const after = rewritten.get(entry.id);
        if (entry.label === "rewrite") {
            const wanted = normalizeClassList(entry.to);
            if (after === wanted) {
                counts.tp += 1;
            } else if (after === before) {
                counts.fn += 1;
                misses.push(`${entry.id}: not rewritten ("${before}", wanted "${wanted}")`);
            } else {
                counts.fp += 1;
                counts.fn += 1;
                misses.push(`${entry.id}: wrong rewrite "${before}" -> "${after}", wanted "${wanted}"`);
            }
        } else if (after === before) {
            counts.tn += 1;
        } else {
            counts.fp += 1;
            misses.push(`${entry.id}: rewritten but labelled keep "${before}" -> "${after}"`);
        }
    }
    return { counts, misses };
}

function printPass(name, { counts, misses }, metrics) {
    const { tp, fp, fn, tn } = counts;
    console.log(`${name}: TP ${tp}  FP ${fp}  FN ${fn}  TN ${tn}`);
    console.log(
        `  precision ${formatRatio(metrics.precision)} (floor ${FLOORS.precision})`
        + `  recall ${formatRatio(metrics.recall)} (floor ${FLOORS.recall})`
        + `  FPR ${formatRatio(metrics.falsePositiveRate)} (ceiling ${FLOORS.falsePositiveRate})`,
    );
    for (const miss of misses) {
        console.log(`  - ${miss}`);
    }
}

async function main() {
    const json = process.argv.slice(2).includes("--json");
    let cases;
    try {
        cases = validateCorpus(JSON.parse(await fs.readFile(CORPUS_PATH, "utf8")));
    } catch (err) {
        console.error(`precision: bad corpus ${CORPUS_PATH}: ${err.message}`);
        process.exitCode = 2;
        return;
    }

    const detection = scoreDetection(cases, await detectFlaggedCases(cases));
    const rewrite = scoreRewrite(cases, await rewriteCases(cases));
    const passes = [
        { name: "detection", ...detection, metrics: scoreConfusion(detection.counts) },
        { name: "rewrite", ...rewrite, metrics: scoreConfusion(rewrite.counts) },
    ];
    const failures = passes.flatMap((pass) => gateFailures(pass.name, pass.metrics));

    if (json) {
        console.log(JSON.stringify({ floors: FLOORS, cases: cases.length, passes, failures }, null, 2));
    } else {
        for (const pass of passes) {
            printPass(pass.name, pass, pass.metrics);
        }
        console.log("");
        for (const failure of failures) {
            console.log(`FAIL ${failure}`);
        }
        console.log(`${cases.length} labelled cases, ${failures.length} gate failures.`);
    }
    process.exitCode = failures.length > 0 ? 1 : 0;
}

// Run only as a script, so the unit test can import the scoring functions.
// Windows paths compare case-insensitively (the drive letter's case varies).
function isInvokedDirectly() {
    if (!process.argv[1]) {
        return false;
    }
    const invoked = path.resolve(process.argv[1]);
    const self = fileURLToPath(import.meta.url);
    return process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

if (isInvokedDirectly()) {
    main().catch((err) => {
        console.error("precision: fatal error");
        console.error(err);
        process.exitCode = 2;
    });
}
