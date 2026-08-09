#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const require = createRequire(import.meta.url);
const NCC_CLI = require.resolve("@vercel/ncc/dist/ncc/cli.js");
const CHECK_ONLY = process.argv.includes("--check");

function assertSafeDistPath(target) {
    if (path.resolve(path.dirname(target)) !== REPO_ROOT || path.basename(target) !== "dist") {
        throw new Error(`Refusing to replace unexpected dist path: ${target}`);
    }
}

async function buildEntry(input, outputDirectory, licenseFile) {
    await execFileAsync(
        process.execPath,
        [
            NCC_CLI,
            "build",
            input,
            "--out",
            outputDirectory,
            "--minify",
            "--no-cache",
            "--target",
            "es2022",
            "--license",
            licenseFile,
            "--quiet",
        ],
        { cwd: REPO_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
}

async function listFiles(root) {
    const result = [];
    async function walk(current) {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
            } else if (entry.isFile()) {
                result.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
            }
        }
    }
    await walk(root);
    return result;
}

async function compareDirectories(expected, actual) {
    const expectedFiles = await listFiles(expected);
    const actualFiles = await listFiles(actual).catch(() => []);
    if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
        throw new Error(`Committed dist file list is stale. Expected ${expectedFiles.join(", ")}; found ${actualFiles.join(", ") || "nothing"}. Run npm run build:action.`);
    }
    for (const relative of expectedFiles) {
        const [left, right] = await Promise.all([
            fs.readFile(path.join(expected, relative)),
            fs.readFile(path.join(actual, relative)),
        ]);
        if (!left.equals(right)) {
            let firstDifference = 0;
            const sharedLength = Math.min(left.length, right.length);
            while (firstDifference < sharedLength && left[firstDifference] === right[firstDifference]) {
                firstDifference += 1;
            }
            const contextStart = Math.max(0, firstDifference - 80);
            const contextEnd = firstDifference + 160;
            const digest = (value) => createHash("sha256").update(value).digest("hex");
            const context = (value) => JSON.stringify(value.subarray(contextStart, contextEnd).toString("utf8"));
            throw new Error(
                `Committed dist/${relative} is stale at byte ${firstDifference}. `
                + `generated=${digest(left)} committed=${digest(right)}; `
                + `generated-context=${context(left)} committed-context=${context(right)}. `
                + "Run npm run build:action.",
            );
        }
    }
}

async function normalizeTextFile(filePath) {
    const text = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, text.replace(/\r\n?/g, "\n"), "utf8");
}

// ncc derives its internal module ids from the resolved paths of the modules
// it bundles, so the SAME source produces different bytes depending on how
// node_modules was laid out. A flat `npm ci` tree and bun's isolated linker
// (which symlinks each package out to a shared global store) therefore emit
// bundles that differ from byte ~46 onward even though they behave identically.
//
// CI installs with `npm ci`, and that is also what a consumer of the Action
// gets, so the npm layout is the canonical one and the committed dist/ must
// match it. Locally, comparing a bun-built bundle against an npm-built
// baseline is a guaranteed false failure, so the byte comparison is skipped
// there with a loud note rather than reporting drift that does not exist.
async function nodeModulesIsCanonical() {
    for (const dependency of ["tailwindcss", "@babel/parser", "@vercel/ncc"]) {
        const entry = path.join(REPO_ROOT, "node_modules", ...dependency.split("/"));
        const stats = await fs.lstat(entry).catch(() => null);
        if (stats?.isSymbolicLink()) {
            return false;
        }
    }
    return true;
}

async function main() {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-action-build-"));
    const actionOutput = path.join(tempRoot, "action");
    const cliOutput = path.join(tempRoot, "cli");
    const generatedDist = path.join(tempRoot, "dist");

    try {
        await Promise.all([
            buildEntry("action/index.mjs", actionOutput, "ACTION_THIRD_PARTY_LICENSES.txt"),
            buildEntry("bin/normwind.mjs", cliOutput, "CLI_THIRD_PARTY_LICENSES.txt"),
        ]);
        await fs.mkdir(generatedDist, { recursive: true });
        await Promise.all([
            fs.copyFile(path.join(actionOutput, "index.mjs"), path.join(generatedDist, "index.mjs")),
            fs.copyFile(path.join(cliOutput, "index.mjs"), path.join(generatedDist, "normwind.mjs")),
            fs.copyFile(
                require.resolve("tailwindcss/index.css"),
                path.join(generatedDist, "tailwindcss-index.css"),
            ),
            fs.copyFile(
                path.join(actionOutput, "ACTION_THIRD_PARTY_LICENSES.txt"),
                path.join(generatedDist, "ACTION_THIRD_PARTY_LICENSES.txt"),
            ),
            fs.copyFile(
                path.join(cliOutput, "CLI_THIRD_PARTY_LICENSES.txt"),
                path.join(generatedDist, "CLI_THIRD_PARTY_LICENSES.txt"),
            ),
        ]);
        await Promise.all(
            (await listFiles(generatedDist)).map((relative) =>
                normalizeTextFile(path.join(generatedDist, relative)),
            ),
        );

        if (CHECK_ONLY) {
            if (!(await nodeModulesIsCanonical())) {
                console.log(
                    "Action bundle byte check SKIPPED: node_modules was not installed by npm "
                    + "(a symlinked package store changes ncc's module ids, so the bytes cannot match). "
                    + "CI installs with `npm ci` and enforces this check there. "
                    + "To regenerate the committed bundle, build from an npm-installed tree.",
                );
                return;
            }
            await compareDirectories(generatedDist, DIST_DIR);
            console.log("Action bundle is up to date.");
            return;
        }

        if (!(await nodeModulesIsCanonical())) {
            throw new Error(
                "Refusing to write dist/ from a non-npm node_modules. ncc bakes resolved module "
                + "paths into the bundle, so a bun/pnpm store produces bytes CI can never reproduce. "
                + "Run `npm ci` first (or build in a clean npm-installed checkout) and re-run.",
            );
        }

        assertSafeDistPath(DIST_DIR);
        await fs.rm(DIST_DIR, { recursive: true, force: true });
        await fs.cp(generatedDist, DIST_DIR, { recursive: true });
        console.log("Built GitHub Action bundles in dist/.");
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(`build-action: ${error.message}`);
    process.exitCode = 1;
});
