#!/usr/bin/env node
/**
 * Canonical snapshot parity test.
 *
 * Runs every fixture twice:
 *   1. without docs/reference/canonical-replacements.json
 *      so NormWind must ask Tailwind's live design-system canonicalizer;
 *   2. with the committed docs/reference snapshot copied into the temp cwd
 *      so NormWind should resolve canonical arbitrary values from the snapshot.
 *
 * The finding output must be identical. Any diff means the committed snapshot
 * has drifted from Tailwind's live canonicalization behavior for the tested
 * corpus, or the snapshot lookup path has a bug.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const NORMWIND_BIN = path.join(REPO_ROOT, "bin", "normwind.mjs");
const FIXTURES_ROOT = path.join(REPO_ROOT, "test", "fixtures");
const SNAPSHOT_JSON = path.join(REPO_ROOT, "docs", "reference", "canonical-replacements.json");
const SNAPSHOT_MD = path.join(REPO_ROOT, "docs", "reference", "canonical-replacements.md");
const NODE_BIN = process.execPath;
const ALLOWED_EXTENSIONS = new Set([".vue", ".tsx", ".ts", ".jsx", ".js", ".mjs"]);

function parseArgs(argv) {
    const flags = { filter: null, json: false };
    for (const arg of argv) {
        if (arg === "--json") {
            flags.json = true;
        } else if (arg.startsWith("--filter=")) {
            flags.filter = arg.slice("--filter=".length);
        }
    }
    return flags;
}

async function listFixtures(filter) {
    const entries = await fs.readdir(FIXTURES_ROOT, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    return (filter ? dirs.filter((d) => d.includes(filter)) : dirs).sort();
}

async function findInputFile(fixtureDir) {
    const entries = await fs.readdir(fixtureDir);
    for (const name of entries) {
        if (name.startsWith("input.") && ALLOWED_EXTENSIONS.has(path.extname(name))) {
            return name;
        }
    }
    return null;
}

async function makeRunDir(fixtureDir, inputName, { withSnapshot }) {
    const dir = path.join(os.tmpdir(), `normwind-compare-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(path.join(fixtureDir, inputName), path.join(dir, inputName));

    if (withSnapshot) {
        const referenceDir = path.join(dir, "docs", "reference");
        await fs.mkdir(referenceDir, { recursive: true });
        await fs.copyFile(SNAPSHOT_JSON, path.join(referenceDir, path.basename(SNAPSHOT_JSON)));
        await fs.copyFile(SNAPSHOT_MD, path.join(referenceDir, path.basename(SNAPSHOT_MD)));
    }

    return dir;
}

async function rmrf(dir) {
    await fs.rm(dir, { recursive: true, force: true });
}

async function runNormwind(cwd, extraEnv = {}) {
    try {
        const { stdout, stderr } = await execFileAsync(NODE_BIN, [NORMWIND_BIN, "--json"], {
            cwd,
            env: { ...process.env, ...extraEnv, NO_COLOR: "1", FORCE_COLOR: "0" },
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

function parseJson(stdout) {
    const trimmed = stdout.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
        return null;
    }
    return JSON.parse(trimmed.slice(start, end + 1));
}

function normalize(payload) {
    return {
        ruleId: payload.ruleId,
        lintedFiles: payload.lintedFiles,
        findingCount: payload.findingCount,
        findings: payload.findings,
    };
}

async function compareFixture(fixture) {
    const fixtureDir = path.join(FIXTURES_ROOT, fixture);
    const inputName = await findInputFile(fixtureDir);
    if (!inputName) {
        return { fixture, ok: false, error: "missing input.* fixture" };
    }

    const liveDir = await makeRunDir(fixtureDir, inputName, { withSnapshot: false });
    const snapshotDir = await makeRunDir(fixtureDir, inputName, { withSnapshot: true });

    try {
        const [liveRun, snapshotRun] = await Promise.all([
            runNormwind(liveDir, { NORMWIND_DISABLE_CANONICAL_SNAPSHOT: "1" }),
            runNormwind(snapshotDir),
        ]);
        const livePayload = parseJson(liveRun.stdout);
        const snapshotPayload = parseJson(snapshotRun.stdout);
        if (!livePayload || !snapshotPayload) {
            return {
                fixture,
                ok: false,
                error: `missing JSON output (live=${liveRun.exitCode}, snapshot=${snapshotRun.exitCode})`,
            };
        }

        const live = normalize(livePayload);
        const snapshot = normalize(snapshotPayload);
        const ok = JSON.stringify(live) === JSON.stringify(snapshot);
        return ok
            ? { fixture, ok: true, liveFindingCount: live.findingCount }
            : { fixture, ok: false, error: "snapshot output differs from live Tailwind canonicalization", live, snapshot };
    } finally {
        await Promise.all([rmrf(liveDir), rmrf(snapshotDir)]);
    }
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    const fixtures = await listFixtures(flags.filter);
    const results = [];

    for (const fixture of fixtures) {
        results.push(await compareFixture(fixture));
    }

    const failures = results.filter((r) => !r.ok);
    if (flags.json) {
        console.log(JSON.stringify(results, null, 2));
    } else {
        for (const result of results) {
            console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.fixture}`);
            if (!result.ok) {
                console.log(`  ${result.error}`);
                if (result.live || result.snapshot) {
                    console.log(`  live:     ${JSON.stringify(result.live)}`);
                    console.log(`  snapshot: ${JSON.stringify(result.snapshot)}`);
                }
            }
        }
        console.log("");
        console.log(`${results.length} fixtures, ${failures.length} failures.`);
    }

    process.exitCode = failures.length > 0 ? 1 : 0;
}

main().catch((err) => {
    console.error("compare: fatal error");
    console.error(err);
    process.exitCode = 2;
});
