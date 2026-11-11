#!/usr/bin/env node
/**
 * Canonical snapshot parity test.
 *
 * Runs every fixture twice:
 *   1. with NORMWIND_DISABLE_CANONICAL_SNAPSHOT=1, so NormWind must ask
 *      Tailwind's live design-system canonicalizer;
 *   2. normally, so NormWind resolves canonical arbitrary values from the
 *      snapshot shipped in the package (in this checkout, the committed
 *      docs/reference file; a scanned project's own copy is never read).
 *
 * The finding output must be identical. Any diff means the committed snapshot
 * has drifted from Tailwind's live canonicalization behavior for the tested
 * corpus, or the snapshot lookup path has a bug.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { FIXTURES_ROOT, findFixtureInput, fixtureJobs, listFixtures, mapPool, runNormwind } from "./cli-harness.mjs";

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

async function makeRunDir(fixtureDir, inputName) {
    const dir = path.join(os.tmpdir(), `normwind-compare-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(path.join(fixtureDir, inputName), path.join(dir, inputName));
    return dir;
}

async function rmrf(dir) {
    await fs.rm(dir, { recursive: true, force: true });
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
    const input = await findFixtureInput(fixtureDir);
    if (!input) {
        return { fixture, ok: false, error: "missing input.* fixture" };
    }
    const inputName = input.name;

    const liveDir = await makeRunDir(fixtureDir, inputName);
    const snapshotDir = await makeRunDir(fixtureDir, inputName);

    try {
        const [liveRun, snapshotRun] = await Promise.all([
            runNormwind(["--json"], liveDir, { NORMWIND_DISABLE_CANONICAL_SNAPSHOT: "1" }),
            runNormwind(["--json"], snapshotDir),
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
    // Each fixture runs the CLI twice at once (live and snapshot), so half as many fixtures run together.
    const results = await mapPool(fixtures, Math.ceil(fixtureJobs() / 2), compareFixture);

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
