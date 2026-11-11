/**
 * The one place the check scripts run the NormWind CLI and walk the fixtures.
 *
 * check-regression, check-compare and check-precision import these instead of
 * keeping their own copies. Each CLI run starts in its own temporary folder and
 * spends most of its time loading Tailwind's engine, so runs are independent
 * and a check runs several at once (`mapPool`, `fixtureJobs`). Run one at a
 * time, the regression and parity checks took about 8 of CI's 11 minutes.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NORMWIND_BIN = path.join(REPO_ROOT, "bin", "normwind.mjs");
export const FIXTURES_ROOT = path.join(REPO_ROOT, "test", "fixtures");

const FIXTURE_INPUT_PREFIX = "input.";
const FIXTURE_EXTENSIONS = new Set([".vue", ".tsx", ".ts", ".jsx", ".js", ".mjs"]);

// Runs the CLI with colour off. A non-zero exit is a result, not an error: the
// findings are on stdout either way.
export async function runNormwind(args, cwd, extraEnv = {}) {
    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [NORMWIND_BIN, ...args], {
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

export async function listFixtures(filter) {
    const entries = await fs.readdir(FIXTURES_ROOT, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    return (filter ? dirs.filter((d) => d.includes(filter)) : dirs).sort();
}

// A fixture's input is its one `input.<ext>` file of a type the CLI lints.
export async function findFixtureInput(fixtureDir) {
    const entries = await fs.readdir(fixtureDir);
    for (const name of entries) {
        const ext = path.extname(name);
        if (name.startsWith(FIXTURE_INPUT_PREFIX) && FIXTURE_EXTENSIONS.has(ext)) {
            return { name, ext };
        }
    }
    return null;
}

// How many CLI runs a check keeps going at once: NORMWIND_FIXTURE_JOBS, else one
// per core up to 8 (each run holds its own Tailwind engine in memory).
export function fixtureJobs() {
    const fromEnv = Number.parseInt(process.env.NORMWIND_FIXTURE_JOBS ?? "", 10);
    if (Number.isInteger(fromEnv) && fromEnv > 0) {
        return fromEnv;
    }
    return Math.max(1, Math.min(os.availableParallelism(), 8));
}

// Maps `fn` over `items` with at most `limit` calls in flight. Results keep the
// order of `items`, so a check's report reads the same however the runs finish.
export async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index], index);
        }
    }
    const workers = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
}
