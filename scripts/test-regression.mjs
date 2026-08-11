#!/usr/bin/env node
/**
 * NormWind regression harness.
 *
 * For every directory under test/fixtures/, runs the CLI under three modes
 * and diffs the output against committed expectations.
 *
 *   audit:        node bin/normwind.mjs --json   (cwd=fixture)
 *                 -> compares findings vs expected.json
 *
 *   fix:          copies input.* to a tmp run dir, runs --fix --json,
 *                 then captures the rewritten file content and diffs
 *                 against expected.fixed.<ext>
 *
 *   fixall:       same as fix, but with --fixall, diffed against
 *                 expected.fixall.<ext> when present (otherwise expected.fixed.<ext>).
 *
 * Modes:
 *   --update     write actual outputs to expected.* files (use to capture
 *                a new baseline; review the git diff before committing).
 *   --filter=X   only run fixtures whose dir name matches substring X.
 *   --json       emit a machine-readable summary to stdout.
 *
 * Exit codes:
 *   0 -> all fixtures pass
 *   1 -> at least one fixture diverges from expectations
 *   2 -> harness itself failed (missing input, runtime error, etc.)
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
const NODE_BIN = process.execPath;

const FIXTURE_INPUT_PREFIX = "input.";
const ALLOWED_EXTENSIONS = new Set([".vue", ".tsx", ".ts", ".jsx", ".js", ".mjs"]);

function parseArgs(argv) {
    const flags = { update: false, json: false, filter: null };
    for (const arg of argv) {
        if (arg === "--update") {
            flags.update = true;
        } else if (arg === "--json") {
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
    const filtered = filter ? dirs.filter((d) => d.includes(filter)) : dirs;
    return filtered.sort();
}

async function findInputFile(fixtureDir) {
    const entries = await fs.readdir(fixtureDir);
    for (const name of entries) {
        if (name.startsWith(FIXTURE_INPUT_PREFIX)) {
            const ext = path.extname(name);
            if (ALLOWED_EXTENSIONS.has(ext)) {
                return { name, ext };
            }
        }
    }
    return null;
}

async function copyFixtureToTmp(fixtureDir, inputName) {
    const tmpDir = path.join(os.tmpdir(), `normwind-fixture-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const src = path.join(fixtureDir, inputName);
    const dst = path.join(tmpDir, inputName);
    await fs.copyFile(src, dst);
    return tmpDir;
}

async function rmrf(dirPath) {
    await fs.rm(dirPath, { recursive: true, force: true });
}

// Passing runs should leave a fixture dir clean. `actual.*` siblings are only
// ever scratch output written on a MISMATCH (for human review); if a previous
// failing run left one behind and the fixture now passes, a stale actual.*
// would misleadingly suggest the fixture is still broken. Delete any stale
// actual.* before each run so a clean pass always leaves a clean directory.
async function cleanStaleActualFiles(fixtureDir) {
    const entries = await fs.readdir(fixtureDir).catch(() => []);
    for (const name of entries) {
        if (name.startsWith("actual.")) {
            await fs.rm(path.join(fixtureDir, name), { force: true });
        }
    }
}

async function runNormwind(args, cwd) {
    try {
        const { stdout, stderr } = await execFileAsync(NODE_BIN, [NORMWIND_BIN, ...args], {
            cwd,
            env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", NORMWIND_NO_PING: "1" },
            maxBuffer: 32 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
    } catch (err) {
        // execFile rejects on non-zero exit, but we still want stdout (findings).
        if (typeof err.code === "number") {
            return { exitCode: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
        }
        throw err;
    }
}

function parseFindingsJson(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return null;
    }
    // The CLI may emit non-JSON header text in --fix mode before the audit JSON.
    // Locate the last balanced JSON object in the output.
    const lastBraceClose = trimmed.lastIndexOf("}");
    if (lastBraceClose === -1) {
        return null;
    }
    let depth = 0;
    let start = -1;
    for (let i = lastBraceClose; i >= 0; i -= 1) {
        const ch = trimmed[i];
        if (ch === "}") {
            depth += 1;
        } else if (ch === "{") {
            depth -= 1;
            if (depth === 0) {
                start = i;
                break;
            }
        }
    }
    if (start === -1) {
        return null;
    }
    try {
        return JSON.parse(trimmed.slice(start, lastBraceClose + 1));
    } catch {
        return null;
    }
}

// Strip volatile fields so expected.json is stable across version bumps.
function normalizeFindings(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }
    return {
        ruleId: payload.ruleId,
        lintedFiles: payload.lintedFiles,
        findingCount: payload.findingCount,
        findings: Array.isArray(payload.findings)
            ? payload.findings.map((f) => ({
                filePath: f.filePath,
                line: f.line,
                column: f.column,
                message: f.message,
            }))
            : [],
    };
}

async function readJsonIfExists(filePath) {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === "ENOENT") {
            return null;
        }
        throw err;
    }
}

async function readTextIfExists(filePath) {
    try {
        return await fs.readFile(filePath, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") {
            return null;
        }
        throw err;
    }
}

async function writeJson(filePath, value) {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function diffSummary(label, expected, actual) {
    if (expected === null) {
        return `  ${label}: no baseline (run with --update to capture).`;
    }
    if (deepEqual(expected, actual)) {
        return null;
    }
    return `  ${label}: MISMATCH\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
}

// Some fixtures need extra CLI flags (e.g. --theme-css). Convention: any
// fixture directory containing a theme.css file is run with that file as the
// --theme-css argument and (for the audit pass) with --suggest-named-theme-vars
// so the resolver is exercised end-to-end. Audit gating for the suggestion
// flag is intentional -- it's the existing public contract; fix-time engages
// the resolver automatically whenever --theme-css is set.
async function fixtureExtraArgs(fixtureDir, mode) {
    const themeCssPath = path.join(fixtureDir, "theme.css");
    try {
        await fs.access(themeCssPath);
    } catch {
        return [];
    }
    const tmpThemePath = path.join(fixtureDir, "theme.css");
    const args = ["--theme-css", tmpThemePath];
    if (mode === "audit") {
        args.push("--suggest-named-theme-vars");
    }
    return args;
}

// Exit-code contract: 1 when findings exist, 0 when clean. This is an
// invariant on top of the baseline comparison, not a baseline field itself:
// expected.json's shape must not change to accommodate it.
function checkExitCodeInvariant(label, exitCode, findingCount) {
    if (findingCount > 0 && exitCode !== 1) {
        return `  ${label}: exit-code invariant violated: findingCount=${findingCount} (>0) but exitCode=${exitCode} (expected 1)`;
    }
    if (findingCount === 0 && exitCode !== 0) {
        return `  ${label}: exit-code invariant violated: findingCount=${findingCount} (===0) but exitCode=${exitCode} (expected 0)`;
    }
    return null;
}

async function runAudit(fixtureDir, fixture, options) {
    const input = await findInputFile(fixtureDir);
    if (!input) {
        return { ok: false, label: "audit", error: "no input.* file in fixture" };
    }

    const tmpDir = await copyFixtureToTmp(fixtureDir, input.name);
    const extraArgs = await fixtureExtraArgs(fixtureDir, "audit");
    try {
        const { exitCode, stdout, stderr } = await runNormwind(["--json", ...extraArgs], tmpDir);
        const parsed = parseFindingsJson(stdout);
        if (!parsed) {
            return {
                ok: false,
                label: "audit",
                error: `no JSON output (exit=${exitCode}); stderr=${stderr.trim()}`,
            };
        }
        const actual = normalizeFindings(parsed);

        const invariantError = checkExitCodeInvariant("audit", exitCode, actual.findingCount);
        if (invariantError) {
            return { ok: false, label: "audit", error: invariantError };
        }

        const expectedPath = path.join(fixtureDir, "expected.json");
        if (options.update) {
            await writeJson(expectedPath, actual);
            return { ok: true, label: "audit", note: "baseline written" };
        }
        const expected = await readJsonIfExists(expectedPath);
        const diff = diffSummary("audit", expected, actual);
        if (diff) {
            // Emit an .actual.json sibling for human review.
            await writeJson(path.join(fixtureDir, "actual.json"), actual);
            return { ok: false, label: "audit", error: diff };
        }
        return { ok: true, label: "audit" };
    } finally {
        await rmrf(tmpDir);
    }
}

async function runFixVariant(fixtureDir, fixture, fixFlag, expectedSuffix, options) {
    const input = await findInputFile(fixtureDir);
    if (!input) {
        return { ok: false, label: fixFlag, error: "no input.* file in fixture" };
    }
    const tmpDir = await copyFixtureToTmp(fixtureDir, input.name);
    const extraArgs = await fixtureExtraArgs(fixtureDir, "fix");
    try {
        const { exitCode, stdout, stderr } = await runNormwind([fixFlag, "--json", ...extraArgs], tmpDir);
        const writtenPath = path.join(tmpDir, input.name);
        const actualText = await readTextIfExists(writtenPath);
        if (actualText === null) {
            return {
                ok: false,
                label: fixFlag,
                error: `tmp file vanished after ${fixFlag} (exit=${exitCode}); stderr=${stderr.trim()}`,
            };
        }

        // The --fix/--fixall run re-audits the (now-rewritten) files and emits
        // that post-fix findings payload as its --json output; assert the
        // same exit-code invariant holds against it.
        const parsedPostFix = parseFindingsJson(stdout);
        if (!parsedPostFix) {
            return {
                ok: false,
                label: fixFlag,
                error: `no JSON output after ${fixFlag} (exit=${exitCode}); stderr=${stderr.trim()}`,
            };
        }
        const invariantError = checkExitCodeInvariant(fixFlag, exitCode, parsedPostFix.findingCount);
        if (invariantError) {
            return { ok: false, label: fixFlag, error: invariantError };
        }

        const expectedPath = path.join(fixtureDir, `expected.${expectedSuffix}${input.ext}`);
        if (options.update) {
            await fs.writeFile(expectedPath, actualText, "utf8");
            return { ok: true, label: fixFlag, note: "baseline written" };
        }

        // A fixture whose input is already normalized turns the fix comparison
        // into a trivial identity check that passes while verifying nothing.
        // That is exactly what happens if someone runs the fixer over the
        // fixture tree by accident and then regenerates baselines instead of
        // restoring the inputs. Fail loudly rather than going quietly green.
        //
        // Deliberate no-op fixtures opt out with a `.no-op` marker file.
        const originalText = await readTextIfExists(path.join(fixtureDir, input.name));
        const isDeclaredNoOp = await fs
            .access(path.join(fixtureDir, ".no-op"))
            .then(() => true)
            .catch(() => false);
        const expectedForOptOut = await readTextIfExists(expectedPath);
        if (
            !isDeclaredNoOp
            && originalText !== null
            && expectedForOptOut !== null
            && originalText === expectedForOptOut
            && expectedSuffix === "fixall"
        ) {
            return {
                ok: false,
                label: fixFlag,
                error: `  ${fixFlag}: input.${input.ext.slice(1)} is byte-identical to ${path.basename(expectedPath)}, so this fixture no longer exercises the fix path. Restore the un-normalized input, or add an empty .no-op file to the fixture directory if the no-op IS the assertion.`,
            };
        }

        const expected = await readTextIfExists(expectedPath);
        if (expected === null) {
            await fs.writeFile(path.join(fixtureDir, `actual.${expectedSuffix}${input.ext}`), actualText, "utf8");
            return { ok: false, label: fixFlag, error: `no baseline at ${path.basename(expectedPath)} (run with --update).` };
        }
        if (expected !== actualText) {
            await fs.writeFile(path.join(fixtureDir, `actual.${expectedSuffix}${input.ext}`), actualText, "utf8");
            return {
                ok: false,
                label: fixFlag,
                error: `${path.basename(expectedPath)} differs (see actual.${expectedSuffix}${input.ext})`,
            };
        }
        return { ok: true, label: fixFlag };
    } finally {
        await rmrf(tmpDir);
    }
}

async function runFixture(fixture, options) {
    const fixtureDir = path.join(FIXTURES_ROOT, fixture);
    await cleanStaleActualFiles(fixtureDir);

    const input = await findInputFile(fixtureDir);
    if (!input) {
        return { fixture, results: [{ ok: false, label: "setup", error: "no input.* file" }] };
    }

    const results = [];
    results.push(await runAudit(fixtureDir, fixture, options));
    results.push(await runFixVariant(fixtureDir, fixture, "--fix", "fixed", options));
    results.push(await runFixVariant(fixtureDir, fixture, "--fixall", "fixall", options));
    return { fixture, results };
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    let fixtures;
    try {
        fixtures = await listFixtures(flags.filter);
    } catch (err) {
        console.error(`harness: cannot read ${FIXTURES_ROOT}: ${err.message}`);
        process.exitCode = 2;
        return;
    }

    if (fixtures.length === 0) {
        console.error("harness: no fixtures found.");
        process.exitCode = 2;
        return;
    }

    const summary = [];
    for (const fixture of fixtures) {
        const result = await runFixture(fixture, flags);
        summary.push(result);
    }

    let failed = 0;
    if (flags.json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        for (const { fixture, results } of summary) {
            const fixtureFailed = results.filter((r) => !r.ok).length;
            const status = fixtureFailed === 0 ? "PASS" : "FAIL";
            console.log(`[${status}] ${fixture}`);
            for (const r of results) {
                if (r.note) {
                    console.log(`  ${r.label}: ${r.note}`);
                }
                if (!r.ok) {
                    console.log(r.error);
                }
            }
            failed += fixtureFailed;
        }
        console.log("");
        console.log(`${summary.length} fixtures, ${failed} failures.`);
    }

    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
    console.error("harness: fatal error");
    console.error(err);
    process.exitCode = 2;
});
