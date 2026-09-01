#!/usr/bin/env node
/**
 * Comprehensive pre-push verification for NormWind.
 *
 * This intentionally avoids external test frameworks so it works anywhere the
 * package itself works. It validates:
 *   - package metadata and published file list intent
 *   - generated canonical snapshot integrity and drift
 *   - fixture regression behavior
 *   - live Tailwind canonicalizer vs snapshot parity
 *   - CLI audit/fix smoke behavior in a clean consumer-like temp cwd
 *   - npm pack dry-run includes runtime-critical files
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const NODE_BIN = process.execPath;
const NORMWIND_BIN = path.join(REPO_ROOT, "bin", "normwind.mjs");
const REGRESSION_SCRIPT = path.join(REPO_ROOT, "scripts", "test-regression.mjs");
const COMPARE_SCRIPT = path.join(REPO_ROOT, "scripts", "test-compare.mjs");
const SNAPSHOT_JSON = path.join(REPO_ROOT, "docs", "reference", "canonical-replacements.json");
const SNAPSHOT_MD = path.join(REPO_ROOT, "docs", "reference", "canonical-replacements.md");

const checks = [];

function addCheck(name, fn) {
    checks.push({ name, fn });
}

async function run(command, args, options = {}) {
    try {
        const result = await execFileAsync(command, args, {
            cwd: REPO_ROOT,
            env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...(options.env ?? {}) },
            maxBuffer: 64 * 1024 * 1024,
            ...options,
        });
        return { ok: true, exitCode: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    } catch (err) {
        if (typeof err.code === "number") {
            return { ok: false, exitCode: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
        }
        throw err;
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function rmrf(dir) {
    await fs.rm(dir, { recursive: true, force: true });
}

function parseCliJson(stdout) {
    const trimmed = stdout.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    assert(start !== -1 && end !== -1 && end > start, "CLI did not emit JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
}

addCheck("package metadata", async () => {
    const pkg = await readJson(path.join(REPO_ROOT, "package.json"));
    assert(pkg.type === "module", "package must remain ESM");
    assert(pkg.bin?.normwind === "bin/normwind.mjs", "normwind bin mapping is missing");
    assert(pkg.bin?.normwinds === "bin/normwind.mjs", "normwinds alias mapping is missing");
    assert(pkg.dependencies?.["@babel/parser"], "@babel/parser dependency is missing");
    assert(pkg.dependencies?.tailwindcss, "tailwindcss dependency is missing");
    assert(pkg.dependencies?.["eslint-plugin-tailwindcss"], "eslint-plugin-tailwindcss dependency is missing");
    assert(!pkg.dependencies?.eslint, "eslint must not be a runtime dependency");
    assert(pkg.files.includes("bin/normwind.mjs"), "published files must include bin/normwind.mjs explicitly");
    assert(pkg.files.includes("lib/*.mjs"), "published files must include lib/*.mjs; bin/normwind.mjs imports from it at runtime");
    assert(!pkg.files.includes("bin"), "published files must whitelist bin/normwind.mjs explicitly, not the entire bin/ directory (otherwise *.bak and other scratch files leak into the tarball)");
    assert(pkg.files.includes("docs/reference/canonical-replacements.json"), "published files must include canonical JSON snapshot");
    assert(pkg.files.includes("docs/reference/canonical-replacements.md"), "published files must include canonical MD snapshot");
    assert(pkg.scripts?.["canonical:check"], "canonical:check script is missing");
    assert(pkg.scripts?.["test:regression"], "test:regression script is missing");
    assert(pkg.scripts?.["test:compare"], "test:compare script is missing");
});

addCheck("workflow and release hardening", async () => {
    const ci = await fs.readFile(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const releaseWorkflow = await fs.readFile(
        path.join(REPO_ROOT, ".github", "workflows", "release.yml"),
        "utf8",
    );
    const releaseScript = await fs.readFile(path.join(REPO_ROOT, "scripts", "release.py"), "utf8");
    const workflowText = `${ci}\n${releaseWorkflow}`;
    const actionRefs = [...workflowText.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)].map((match) => match[1]);
    assert(actionRefs.length > 0, "workflows contain no action references");
    assert(
        actionRefs.every((ref) => /^[0-9a-f]{40}$/.test(ref)),
        `every action must be pinned to a full commit SHA: ${actionRefs.join(", ")}`,
    );
    assert(/permissions:\s*\n\s+contents:\s+read/.test(ci), "CI must explicitly use read-only contents permission");
    assert(!releaseScript.includes("remote set-url"), "release script must not persist a PAT in the origin URL");
    assert(!releaseScript.includes('"--tags"'), "release script must not push unrelated local tags");
    assert(releaseScript.includes('"--atomic"'), "release script should push main and the release tag atomically");
    assert(
        !releaseScript.includes("See commit history for full details."),
        "release script must never publish placeholder release notes",
    );
    assert(
        releaseScript.includes("release_notes_from_readme(new_version)"),
        "default release notes must come from the matching detailed README changelog",
    );
});

addCheck("canonical snapshot integrity", async () => {
    const snapshot = await readJson(SNAPSHOT_JSON);
    const markdown = await fs.readFile(SNAPSHOT_MD, "utf8");
    assert(snapshot.source?.engine === "tailwindcss.designSystem.canonicalizeCandidates", "snapshot source engine is wrong");
    assert(typeof snapshot.source?.tailwindVersion === "string", "snapshot Tailwind version missing");
    assert(snapshot.source?.rootFontSizePx === 16, "snapshot root font size must be 16px");
    assert(Number.isInteger(snapshot.totals?.replacementCount), "snapshot replacement count missing");
    assert(snapshot.totals.replacementCount === snapshot.replacements.length, "snapshot replacement count does not match replacements length");
    assert(snapshot.replacements.length > 1000, "snapshot unexpectedly small");
    assert(!Object.prototype.hasOwnProperty.call(snapshot, "generatedAt"), "snapshot must be deterministic; generatedAt is not allowed");
    assert(snapshot.replacements.some((r) => r.inputClass === "rounded-[24px]" && r.canonicalClass === "rounded-3xl"), "expected rounded-[24px] -> rounded-3xl mapping missing");
    assert(markdown.includes("npm run canonical:check"), "canonical markdown should document canonical:check");
});

addCheck("canonical drift check", async () => {
    const result = await run(NODE_BIN, [NORMWIND_BIN, "--check-canonical"]);
    assert(result.ok, `canonical:check failed\n${result.stdout}\n${result.stderr}`);
});

addCheck("check-canonical failure path", async () => {
    // --check-canonical compares against <cwd>/docs/reference/*, so this
    // proves the negative: a deliberately corrupted snapshot must fail the
    // check (exit non-zero), not just pass silently. Without this we'd only
    // ever exercise the "already up to date" branch above.
    const dir = path.join(os.tmpdir(), `normwind-check-canonical-corrupt-${Date.now()}`);
    const docsDir = path.join(dir, "docs", "reference");
    await fs.mkdir(docsDir, { recursive: true });
    const jsonDest = path.join(docsDir, "canonical-replacements.json");
    const mdDest = path.join(docsDir, "canonical-replacements.md");

    try {
        await fs.copyFile(SNAPSHOT_JSON, jsonDest);
        await fs.copyFile(SNAPSHOT_MD, mdDest);

        const snapshot = await readJson(jsonDest);
        assert(Array.isArray(snapshot.replacements) && snapshot.replacements.length > 0, "snapshot has no replacements to corrupt");
        snapshot.replacements[0] = {
            ...snapshot.replacements[0],
            canonicalClass: "corrupted-value-for-test",
        };
        await fs.writeFile(jsonDest, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

        const result = await run(NODE_BIN, [NORMWIND_BIN, "--check-canonical"], { cwd: dir });
        assert(!result.ok, "--check-canonical should fail against a corrupted docs/reference snapshot");
        assert(result.exitCode !== 0, `expected non-zero exit, got ${result.exitCode}`);
    } finally {
        await rmrf(dir);
    }
});

// Compute the actual fixture count once so the assertions match the on-disk
// state. Hard-coding the count would force every fixture addition to chase a
// magic number here; what we actually want is "every fixture is clean and the
// suite still runs all of them".
async function countFixtures() {
    const fixturesDir = path.join(REPO_ROOT, "test", "fixtures");
    const entries = await fs.readdir(fixturesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
}

addCheck("regression fixtures", async () => {
    const result = await run(NODE_BIN, [REGRESSION_SCRIPT]);
    assert(result.ok, `test:regression failed\n${result.stdout}\n${result.stderr}`);
    const expected = await countFixtures();
    assert(expected > 0, "no fixtures found under test/fixtures");
    assert(
        result.stdout.includes(`${expected} fixtures, 0 failures.`),
        `regression summary did not report ${expected} clean fixtures\n${result.stdout}`,
    );
});

addCheck("snapshot/live parity", async () => {
    const result = await run(NODE_BIN, [COMPARE_SCRIPT]);
    assert(result.ok, `test:compare failed\n${result.stdout}\n${result.stderr}`);
    const expected = await countFixtures();
    assert(expected > 0, "no fixtures found under test/fixtures");
    assert(
        result.stdout.includes(`${expected} fixtures, 0 failures.`),
        `compare summary did not report ${expected} clean fixtures\n${result.stdout}`,
    );
});

addCheck("project-local Tailwind controls canonicalization", async () => {
    async function runWithFakeTailwind(version, { exposesCanonicalizer }) {
        const dir = path.join(
            os.tmpdir(),
            `normwind-project-tailwind-${version}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        const tailwindDir = path.join(dir, "node_modules", "tailwindcss");
        await fs.mkdir(tailwindDir, { recursive: true });
        await fs.writeFile(
            path.join(tailwindDir, "package.json"),
            `${JSON.stringify({
                name: "tailwindcss",
                version,
                main: "./index.cjs",
                exports: {
                    ".": "./index.cjs",
                    "./package.json": "./package.json",
                    "./index.css": "./index.css",
                },
            }, null, 2)}\n`,
            "utf8",
        );
        await fs.writeFile(
            path.join(tailwindDir, "index.cjs"),
            exposesCanonicalizer
                ? `module.exports = { __unstable__loadDesignSystem: async () => ({ canonicalizeCandidates: (candidates) => candidates }) };\n`
                : `module.exports = { __unstable__loadDesignSystem: async () => ({}) };\n`,
            "utf8",
        );
        await fs.writeFile(path.join(tailwindDir, "index.css"), "/* fake project Tailwind */\n", "utf8");
        await fs.writeFile(
            path.join(dir, "Input.vue"),
            `<template><div class="bg-[#FFF]"></div></template>\n`,
            "utf8",
        );

        try {
            const result = await run(NODE_BIN, [NORMWIND_BIN, "Input.vue", "--json"], { cwd: dir });
            assert(
                result.exitCode === 0,
                `Tailwind ${version} compatibility run failed\n${result.stdout}\n${result.stderr}`,
            );
            const payload = parseCliJson(result.stdout);
            assert(
                payload.findingCount === 0,
                `bundled Tailwind canonicalization leaked into Tailwind ${version}: ${result.stdout}`,
            );
            const cache = await readJson(
                path.join(dir, "node_modules", ".cache", "normwinds", "canonical-cache.json"),
            );
            assert(
                cache.tailwindVersion === version,
                `cache used ${cache.tailwindVersion} instead of project Tailwind ${version}`,
            );
        } finally {
            await rmrf(dir);
        }
    }

    // Tailwind 4.1+ exposes canonicalizeCandidates. Tailwind 4.0 does not;
    // arbitrary canonicalization must safely become a no-op there rather than
    // applying newer bundled semantics or crashing.
    await runWithFakeTailwind("4.2.4", { exposesCanonicalizer: true });
    await runWithFakeTailwind("4.0.17", { exposesCanonicalizer: false });
});

addCheck("CLI smoke audit/fix", async () => {
    const dir = path.join(os.tmpdir(), `normwind-smoke-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "Smoke.vue");
    const source = `<template>\n  <div class="px-4 py-4 rounded-[24px] w-[100%]">Smoke</div>\n</template>\n`;
    await fs.writeFile(filePath, source, "utf8");

    try {
        const audit = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(audit.exitCode === 1, `audit should exit 1 when findings exist, got ${audit.exitCode}`);
        const payload = parseCliJson(audit.stdout);
        assert(payload.findingCount >= 3, `expected at least 3 smoke findings, got ${payload.findingCount}`);
        assert(payload.findings.some((f) => f.message.includes("px-4, py-4") && f.message.includes("p-4")), "smoke audit missing padding shorthand finding");
        assert(payload.findings.some((f) => f.message.includes("rounded-[24px]") && f.message.includes("rounded-3xl")), "smoke audit missing rounded canonical finding");
        assert(payload.findings.some((f) => f.message.includes("w-[100%]") && f.message.includes("w-full")), "smoke audit missing width canonical finding");

        const fix = await run(NODE_BIN, [NORMWIND_BIN, "--fix", "--json"], { cwd: dir });
        assert(fix.exitCode === 0, `fix should exit 0 after rewriting findings, got ${fix.exitCode}\n${fix.stdout}\n${fix.stderr}`);
        const fixed = await fs.readFile(filePath, "utf8");
        assert(fixed.includes('class="p-4 rounded-3xl w-full"'), `smoke fix output was not canonicalized: ${fixed}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("stale cache invalidation and compaction", async () => {
    const dir = path.join(os.tmpdir(), `normwind-stale-cache-${Date.now()}`);
    const cacheDir = path.join(dir, "node_modules", ".cache", "normwinds");
    const cachePath = path.join(cacheDir, "canonical-cache.json");
    const filePath = path.join(dir, "Input.vue");
    const candidate = "w-[777.123px]";
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
        cachePath,
        JSON.stringify({
            schema: 1,
            tailwindVersion: "0.0.0-stale",
            entries: { [candidate]: "w-full" },
        }),
        "utf8",
    );
    await fs.writeFile(
        filePath,
        `<template><div class="${candidate}"></div></template>\n`,
        "utf8",
    );

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "Input.vue", "--json"], { cwd: dir });
        assert(result.exitCode === 0, `stale cache must not create a false finding\n${result.stdout}\n${result.stderr}`);
        const payload = JSON.parse(result.stdout);
        assert(payload.findingCount === 0, `stale cached replacement leaked into findings: ${result.stdout}`);

        const rewrittenCache = await readJson(cachePath);
        const tailwindPkg = await readJson(path.join(REPO_ROOT, "node_modules", "tailwindcss", "package.json"));
        assert(
            rewrittenCache.tailwindVersion === tailwindPkg.version,
            `cache version was not refreshed: ${rewrittenCache.tailwindVersion}`,
        );
        assert(
            rewrittenCache.entries[candidate] === candidate,
            `live canonical result was not persisted safely: ${JSON.stringify(rewrittenCache.entries)}`,
        );

        // Simulate a pre-compaction cache that redundantly stored a bundled
        // snapshot key. The next run should remove it while retaining the
        // genuinely dynamic entry.
        rewrittenCache.entries["rounded-[24px]"] = "rounded-3xl";
        await fs.writeFile(cachePath, JSON.stringify(rewrittenCache), "utf8");
        const compactRun = await run(NODE_BIN, [NORMWIND_BIN, "Input.vue", "--json"], { cwd: dir });
        assert(compactRun.exitCode === 0, `cache compaction run failed\n${compactRun.stderr}`);
        const compactedCache = await readJson(cachePath);
        assert(
            !Object.prototype.hasOwnProperty.call(compactedCache.entries, "rounded-[24px]"),
            "writable cache retained an entry already supplied by the bundled snapshot",
        );
        assert(
            Object.keys(compactedCache.entries).length < 10,
            `writable cache should not duplicate the bundled snapshot: ${Object.keys(compactedCache.entries).length}`,
        );
    } finally {
        await rmrf(dir);
    }
});

addCheck("live canonicalization candidate limit", async () => {
    const dir = path.join(os.tmpdir(), `normwind-canonical-limit-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const tokens = Array.from({ length: 1001 }, (_, i) => `w-[${100000 + i}.123px]`);
    await fs.writeFile(
        path.join(dir, "Many.vue"),
        `<template><div class="${tokens.join(" ")}"></div></template>\n`,
        "utf8",
    );

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "Many.vue", "--json"], { cwd: dir });
        assert(result.exitCode === 2, `candidate-limit breach should exit 2, got ${result.exitCode}`);
        assert(
            result.stderr.includes("refusing to live-canonicalize 1001 unique cache misses"),
            `candidate-limit error was not actionable:\n${result.stderr}`,
        );

        const fixResult = await run(
            NODE_BIN,
            [NORMWIND_BIN, "Many.vue", "--fixall", "--dry-run", "--json"],
            { cwd: dir },
        );
        assert(fixResult.exitCode === 2, `fix candidate-limit breach should exit 2, got ${fixResult.exitCode}`);
        assert(
            fixResult.stderr.includes("unique cache misses during fixes"),
            `fix path did not enforce the candidate limit:\n${fixResult.stderr}`,
        );
    } finally {
        await rmrf(dir);
    }
});

addCheck("dry-run writes nothing", async () => {
    const dir = path.join(os.tmpdir(), `normwind-dry-run-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "DryRun.tsx");
    const source = `export const A = () => (\n    <div className="px-4 py-4">A</div>\n);\n`;
    await fs.writeFile(filePath, source, "utf8");

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--fixall", "--dry-run", "--json"], { cwd: dir });
        assert(result.exitCode === 1, `dry-run should still exit 1 (findings remain), got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
        assert(result.stderr.includes("[dry-run] would rewrite"), `dry-run should announce the would-be rewrite on stderr\n${result.stderr}`);
        const payload = JSON.parse(result.stdout);
        assert(payload.findingCount > 0, `dry-run JSON should remain machine-parseable and contain findings: ${result.stdout}`);
        const untouched = await fs.readFile(filePath, "utf8");
        assert(untouched === source, `--dry-run must not modify the file on disk: ${untouched}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("fixall fault isolation: write failure", async () => {
    // NORMWIND_TEST_FORCE_WRITE_FAIL is a test-only hook (mirrors
    // NORMWIND_TEST_FORCE_TRANSFORM_THROW) that makes the atomic temp-file write
    // throw EPERM for one named file, reproducing the real-world EBUSY/EPERM/
    // ENOSPC mode (an editor or antivirus holding the file, a read-only volume)
    // deterministically on every platform. A chmod-based read-only lock is
    // silently ignored under a root CI runner, so it can't be relied on here.
    // This proves one file's write failure does not abort the batch: the other
    // file still gets fixed, a summary is printed, and the process exits with the
    // dedicated partial-failure code (2), not 0 or 1.
    const dir = path.join(os.tmpdir(), `normwind-write-fail-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const lockedPath = path.join(dir, "Locked.vue");
    const okPath = path.join(dir, "Ok.vue");
    await fs.writeFile(lockedPath, `<template>\n  <div class="px-4 py-4">Locked</div>\n</template>\n`, "utf8");
    await fs.writeFile(okPath, `<template>\n  <div class="mt-3 mb-3">Ok</div>\n</template>\n`, "utf8");

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--fixall"], {
            cwd: dir,
            env: { NORMWIND_TEST_FORCE_WRITE_FAIL: "Locked.vue" },
        });
        assert(result.exitCode === 2, `partial-failure run should exit 2, got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
        assert(/fix summary.*1 fixed, 0 skipped, 1 failed/.test(result.stderr), `expected a fixed/skipped/failed summary in stderr, got:\n${result.stderr}`);
        assert(result.stderr.includes("Locked.vue"), `summary should name the failed file:\n${result.stderr}`);

        const lockedContent = await fs.readFile(lockedPath, "utf8");
        assert(lockedContent.includes("px-4 py-4"), `locked file must be left untouched after a write failure: ${lockedContent}`);
        const okContent = await fs.readFile(okPath, "utf8");
        assert(okContent.includes("my-3"), `sibling file must still be fixed despite the earlier write failure: ${okContent}`);

        const leftoverTmp = (await fs.readdir(dir)).filter((name) => name.includes(".normwinds-tmp-"));
        assert(leftoverTmp.length === 0, `temp file must be cleaned up after a failed rename: ${leftoverTmp.join(", ")}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("fixall fault isolation: transform throw", async () => {
    // NORMWIND_TEST_FORCE_TRANSFORM_THROW is a test-only hook (mirrors
    // NORMWIND_DISABLE_CANONICAL_SNAPSHOT) that forces a transform exception
    // for one named file, proving the same per-file isolation applies to a
    // parser/transform edge case, not just I/O errors.
    const dir = path.join(os.tmpdir(), `normwind-transform-throw-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const throwingPath = path.join(dir, "Throws.vue");
    const okPath = path.join(dir, "Ok.vue");
    await fs.writeFile(throwingPath, `<template>\n  <div class="px-4 py-4">Throws</div>\n</template>\n`, "utf8");
    await fs.writeFile(okPath, `<template>\n  <div class="mt-3 mb-3">Ok</div>\n</template>\n`, "utf8");

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--fixall"], {
            cwd: dir,
            env: { NORMWIND_TEST_FORCE_TRANSFORM_THROW: "Throws.vue" },
        });
        assert(result.exitCode === 2, `partial-failure run should exit 2, got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
        assert(/fix summary.*1 fixed, 0 skipped, 1 failed/.test(result.stderr), `expected a fixed/skipped/failed summary in stderr, got:\n${result.stderr}`);
        assert(result.stderr.includes("Throws.vue"), `summary should name the file whose transform threw:\n${result.stderr}`);

        const throwingContent = await fs.readFile(throwingPath, "utf8");
        assert(throwingContent.includes("px-4 py-4"), `file whose transform threw must be left untouched: ${throwingContent}`);
        const okContent = await fs.readFile(okPath, "utf8");
        assert(okContent.includes("my-3"), `sibling file must still be fixed despite the earlier transform throw: ${okContent}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("fixall detects concurrent edits", async () => {
    const dir = path.join(os.tmpdir(), `normwind-concurrent-edit-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "Race.vue");
    await fs.writeFile(
        filePath,
        `<template>\n  <div class="px-4 py-4">Race</div>\n</template>\n`,
        "utf8",
    );

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--fixall"], {
            cwd: dir,
            env: { NORMWIND_TEST_MUTATE_BEFORE_RENAME: "Race.vue" },
        });
        assert(result.exitCode === 2, `concurrent edit should make the run partial, got ${result.exitCode}`);
        assert(result.stderr.includes("file changed while fixes were being prepared"), result.stderr);
        const content = await fs.readFile(filePath, "utf8");
        assert(content.includes("px-4 py-4"), `fixer overwrote the original class edit: ${content}`);
        assert(content.includes("simulated concurrent editor save"), `simulated editor content was lost: ${content}`);
        const leftoverTmp = (await fs.readdir(dir)).filter((name) => name.includes(".normwinds-tmp-"));
        assert(leftoverTmp.length === 0, `temp file must be cleaned up after a conflict: ${leftoverTmp.join(", ")}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("syntax-aware extraction fails closed", async () => {
    const dir = path.join(os.tmpdir(), `normwind-parse-failure-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "Broken.tsx");
    const original = [
        "export const broken = (;",
        '// <div className="px-4 py-4">must never be rewritten</div>',
        "",
    ].join("\n");
    await fs.writeFile(filePath, original, "utf8");

    try {
        const audit = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(audit.exitCode === 2, `parse failure audit should exit 2, got ${audit.exitCode}`);
        assert(
            audit.stderr.includes("[failed:parse]") && audit.stderr.includes("Broken.tsx"),
            `parse failure should be identified precisely:\n${audit.stderr}`,
        );
        const payload = parseCliJson(audit.stdout);
        assert(payload.lintedFiles === 0, `unparsed file must not count as linted: ${audit.stdout}`);

        const fix = await run(NODE_BIN, [NORMWIND_BIN, "--fixall"], { cwd: dir });
        assert(fix.exitCode === 2, `parse failure fix should exit 2, got ${fix.exitCode}`);
        assert(
            await fs.readFile(filePath, "utf8") === original,
            "a source file that cannot be parsed must remain byte-for-byte unchanged",
        );
    } finally {
        await rmrf(dir);
    }
});

addCheck("fixall preserves Unix file mode", async () => {
    if (process.platform === "win32") {
        return;
    }
    const dir = path.join(os.tmpdir(), `normwind-file-mode-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "Executable.js");
    await fs.writeFile(
        filePath,
        `#!/usr/bin/env node\nexport const html = h("div", { class: "px-4 py-4" });\n`,
        { encoding: "utf8", mode: 0o755 },
    );
    await fs.chmod(filePath, 0o755);

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "Executable.js", "--fixall"], { cwd: dir });
        assert(result.exitCode === 0, `mode-preservation fix failed\n${result.stdout}\n${result.stderr}`);
        const mode = (await fs.stat(filePath)).mode & 0o777;
        assert(mode === 0o755, `expected executable mode 0755 after rewrite, got 0${mode.toString(8)}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("max-file-size skip", async () => {
    const dir = path.join(os.tmpdir(), `normwind-max-size-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const bigPath = path.join(dir, "Big.tsx");
    const smallPath = path.join(dir, "Small.tsx");
    const line = 'export const A = () => (<div className="px-4 py-4">A</div>);\n';
    const oversized = line.repeat(Math.ceil((5 * 1024 * 1024 + 1) / line.length));
    await fs.writeFile(bigPath, oversized, "utf8");
    await fs.writeFile(smallPath, `export const B = () => (\n    <div className="mt-3 mb-3">B</div>\n);\n`, "utf8");

    try {
        const audit = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(audit.exitCode === 2, `audit should exit 2 when any matched file is skipped, got ${audit.exitCode}\n${audit.stderr}`);
        assert(audit.stderr.includes("Big.tsx") && audit.stderr.includes("scan limit"), `oversized file skip should be logged:\n${audit.stderr}`);
        const payload = parseCliJson(audit.stdout);
        assert(payload.findings.every((f) => !f.filePath.includes("Big.tsx")), `oversized file must not produce findings: ${JSON.stringify(payload.findings)}`);
        assert(payload.findings.some((f) => f.filePath.includes("Small.tsx")), `small sibling file should still be scanned: ${JSON.stringify(payload.findings)}`);

        const fix = await run(NODE_BIN, [NORMWIND_BIN, "--fixall"], { cwd: dir });
        assert(fix.exitCode === 2, `fixall should exit 2 when an oversized file is skipped, got ${fix.exitCode}\n${fix.stdout}\n${fix.stderr}`);
        const bigContent = await fs.readFile(bigPath, "utf8");
        assert(bigContent === oversized, "oversized file must be left completely untouched by --fixall");
    } finally {
        await rmrf(dir);
    }
});

addCheck("version flag", async () => {
    const pkg = await readJson(path.join(REPO_ROOT, "package.json"));

    const version = await run(NODE_BIN, [NORMWIND_BIN, "--version"]);
    assert(version.ok, `--version should exit 0\n${version.stdout}\n${version.stderr}`);
    assert(version.exitCode === 0, `expected exit 0 for --version, got ${version.exitCode}`);
    assert(
        version.stdout.trim() === pkg.version,
        `--version output "${version.stdout.trim()}" did not match package.json version "${pkg.version}"`,
    );

    const bogus = await run(NODE_BIN, [NORMWIND_BIN, "--definitely-bogus"]);
    assert(!bogus.ok, "unknown flag should cause a non-zero exit");
    assert(bogus.exitCode === 2, `expected exit 2 for an unknown flag, got ${bogus.exitCode}`);
});

addCheck("ripgrep-fallback parity", async () => {
    // The CLI prefers `rg --files` for discovery and falls back to a manual
    // directory walk when `rg` cannot be spawned (ENOENT). Both paths must
    // discover and audit the identical file set; this pins that contract by
    // running the same fixable corpus twice, once with a PATH that excludes
    // ripgrep entirely.
    const dir = path.join(os.tmpdir(), `normwind-rg-parity-${Date.now()}`);
    await fs.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.writeFile(
        path.join(dir, "One.vue"),
        `<template>\n  <div class="px-2 py-2">One</div>\n</template>\n`,
        "utf8",
    );
    await fs.writeFile(
        path.join(dir, "nested", "Two.vue"),
        `<template>\n  <div class="mt-3 mb-3">Two</div>\n</template>\n`,
        "utf8",
    );

    try {
        const normal = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(normal.exitCode === 1, `normal-PATH audit should exit 1, got ${normal.exitCode}\n${normal.stderr}`);
        const normalPayload = parseCliJson(normal.stdout);

        const nodeDir = path.dirname(NODE_BIN);
        const noRg = await run(NODE_BIN, [NORMWIND_BIN, "--json"], {
            cwd: dir,
            env: { PATH: nodeDir, Path: nodeDir },
        });
        assert(noRg.exitCode === 1, `no-rg-PATH audit should exit 1, got ${noRg.exitCode}\n${noRg.stderr}`);
        const noRgPayload = parseCliJson(noRg.stdout);

        assert(noRgPayload.lintedFiles === normalPayload.lintedFiles, `lintedFiles diverged: rg=${normalPayload.lintedFiles} walk=${noRgPayload.lintedFiles}`);
        const normalizeFindings = (payload) =>
            (payload.findings ?? [])
                .map((f) => `${f.filePath}:${f.line}:${f.column}:${f.message}`)
                .sort();
        assert(
            JSON.stringify(normalizeFindings(normalPayload)) === JSON.stringify(normalizeFindings(noRgPayload)),
            `findings diverged between rg and walk fallback\nrg: ${JSON.stringify(normalPayload.findings)}\nwalk: ${JSON.stringify(noRgPayload.findings)}`,
        );
    } finally {
        await rmrf(dir);
    }
});

addCheck("directory and glob targets are unioned", async () => {
    const dir = path.join(os.tmpdir(), `normwind-target-union-${Date.now()}`);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.mkdir(path.join(dir, "other"), { recursive: true });
    await fs.writeFile(
        path.join(dir, "src", "One.vue"),
        `<template><div class="px-2 py-2">One</div></template>\n`,
        "utf8",
    );
    await fs.writeFile(
        path.join(dir, "other", "Two.vue"),
        `<template><div class="mt-3 mb-3">Two</div></template>\n`,
        "utf8",
    );

    try {
        const result = await run(
            NODE_BIN,
            [NORMWIND_BIN, "src", "other/*.vue", "--json"],
            { cwd: dir },
        );
        assert(result.exitCode === 1, `unioned target audit should find both files\n${result.stdout}\n${result.stderr}`);
        const payload = JSON.parse(result.stdout);
        assert(payload.lintedFiles === 2, `expected both directory and glob targets, got ${payload.lintedFiles}`);
        const paths = new Set(payload.findings.map((finding) => finding.filePath));
        assert(paths.has("src/One.vue") && paths.has("other/Two.vue"), JSON.stringify(payload.findings));
    } finally {
        await rmrf(dir);
    }
});

addCheck("fallback walker: symlink loop guard", async () => {
    // Two directories symlinked into each other (A/link -> B, B/link -> A)
    // would recurse forever without a visited-realpath guard. This forces the
    // no-rg fallback walker (ripgrep has its own loop protection and would
    // mask a regression here) and bounds the run with a hard timeout so a
    // reintroduced infinite loop fails this check instead of hanging the
    // whole suite.
    const dir = path.join(os.tmpdir(), `normwind-symlink-loop-${Date.now()}`);
    await fs.mkdir(path.join(dir, "dirA"), { recursive: true });
    await fs.mkdir(path.join(dir, "dirB"), { recursive: true });
    await fs.writeFile(
        path.join(dir, "dirA", "One.vue"),
        `<template>\n  <div class="px-2 py-2">One</div>\n</template>\n`,
        "utf8",
    );
    await fs.writeFile(
        path.join(dir, "dirB", "Two.vue"),
        `<template>\n  <div class="mt-3 mb-3">Two</div>\n</template>\n`,
        "utf8",
    );

    try {
        await fs.symlink(path.join(dir, "dirB"), path.join(dir, "dirA", "link_to_b"), "junction").catch(
            () => fs.symlink(path.join(dir, "dirB"), path.join(dir, "dirA", "link_to_b")),
        );
        await fs.symlink(path.join(dir, "dirA"), path.join(dir, "dirB", "link_to_a"), "junction").catch(
            () => fs.symlink(path.join(dir, "dirA"), path.join(dir, "dirB", "link_to_a")),
        );

        const nodeDir = path.dirname(NODE_BIN);
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--json"], {
            cwd: dir,
            env: { PATH: nodeDir, Path: nodeDir },
            timeout: 15000,
        });
        assert(result.exitCode === 1, `audit should exit 1 (both files have findings), got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
        const payload = parseCliJson(result.stdout);
        assert(payload.lintedFiles === 2, `expected exactly 2 linted files despite the symlink loop, got ${payload.lintedFiles}`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("ignored directories", async () => {
    const dir = path.join(os.tmpdir(), `normwind-ignored-dirs-${Date.now()}`);
    const rootFile = path.join(dir, "Root.vue");
    const nodeModulesFile = path.join(dir, "node_modules", "x", "Copy.vue");
    const distFile = path.join(dir, "dist", "Copy.vue");
    const source = `<template>\n  <div class="px-2 py-2">Copy</div>\n</template>\n`;

    await fs.mkdir(path.dirname(nodeModulesFile), { recursive: true });
    await fs.mkdir(path.dirname(distFile), { recursive: true });
    await fs.writeFile(rootFile, source, "utf8");
    await fs.writeFile(nodeModulesFile, source, "utf8");
    await fs.writeFile(distFile, source, "utf8");

    try {
        const result = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(result.exitCode === 1, `audit should exit 1, got ${result.exitCode}\n${result.stderr}`);
        const payload = parseCliJson(result.stdout);
        assert(payload.lintedFiles === 1, `expected lintedFiles===1 (node_modules/dist excluded), got ${payload.lintedFiles}`);
        assert(
            payload.findings.every((f) => f.filePath.replace(/\\/g, "/") === "Root.vue"),
            `findings should only reference the root file, got ${JSON.stringify(payload.findings)}`,
        );
    } finally {
        await rmrf(dir);
    }
});

addCheck("shorthand merges never change rendered CSS", async () => {
    // The guard these cases exercise is the reason --fix can be trusted at all.
    // Each "unsafe" list contains a broader utility at a different value, so
    // collapsing the narrow ones would hand the win to the broader one and
    // silently change the rendered box.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-merge-safety-"));
    try {
        const unsafe = [
            "mx-8 ml-2 mr-2",
            "size-8 w-4 h-4",
            "w-4 w-6 h-6",
            "p-8 px-4 py-4",
        ];
        const safe = [
            ["px-4 py-4", "p-4"],
            ["w-6 h-6", "size-6"],
            ["border-red-500 border-t-4 border-r-4 border-b-4 border-l-4", "border-red-500 border-4"],
            ["overflow-hidden text-ellipsis whitespace-nowrap", "truncate"],
            ["content-center justify-center", "place-content-center"],
        ];

        const lines = [
            "<template>",
            ...unsafe.map((classes, i) => `  <div class="${classes}">u${i}</div>`),
            ...safe.map(([classes], i) => `  <div class="${classes}">s${i}</div>`),
            "</template>",
            "",
        ];
        const file = path.join(dir, "Merge.vue");
        await fs.writeFile(file, lines.join("\n"), "utf8");

        const fixResult = await run(NODE_BIN, [NORMWIND_BIN, "--fix", "Merge.vue"], { cwd: dir });
        assert(fixResult.exitCode === 0 || fixResult.exitCode === 1, `--fix errored\n${fixResult.stderr}`);
        const after = await fs.readFile(file, "utf8");

        for (const classes of unsafe) {
            assert(
                after.includes(`class="${classes}"`),
                `unsafe merge was applied to \`${classes}\`; --fix must leave it alone\n${after}`,
            );
        }
        for (const [, expected] of safe) {
            assert(
                after.includes(`class="${expected}"`),
                `safe merge to \`${expected}\` did not happen\n${after}`,
            );
        }

        // The contract: a clean audit must imply the fixer is a no-op.
        const audit = await run(NODE_BIN, [NORMWIND_BIN, "--json", "Merge.vue"], { cwd: dir });
        const payload = parseCliJson(audit.stdout);
        assert(payload.findingCount === 0, `re-audit after --fix still reports ${payload.findingCount} finding(s)`);
        const before = await fs.readFile(file, "utf8");
        const second = await run(NODE_BIN, [NORMWIND_BIN, "--fix", "Merge.vue"], { cwd: dir });
        assert(second.exitCode === 0, `second --fix should be clean, got ${second.exitCode}`);
        assert(await fs.readFile(file, "utf8") === before, "audit reported clean but --fix still rewrote the file");
    } finally {
        await rmrf(dir);
    }
});

addCheck("composite equivalences are fixable, not just reportable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-composite-"));
    try {
        const file = path.join(dir, "Composite.vue");
        await fs.writeFile(
            file,
            '<template>\n  <div class="overflow-hidden text-ellipsis whitespace-nowrap">a</div>\n  <div class="self-end justify-self-end">b</div>\n</template>\n',
            "utf8",
        );
        // Audit reports them...
        const audit = await run(NODE_BIN, [NORMWIND_BIN, "--json", "Composite.vue"], { cwd: dir });
        assert(parseCliJson(audit.stdout).findingCount === 2, "expected two composite findings");
        // ...and the fixer clears them, so a fix-then-audit CI loop converges.
        await run(NODE_BIN, [NORMWIND_BIN, "--fix", "Composite.vue"], { cwd: dir });
        const after = await fs.readFile(file, "utf8");
        assert(after.includes('class="truncate"'), `truncate was not applied\n${after}`);
        assert(after.includes('class="place-self-end"'), `place-self-end was not applied\n${after}`);
        const reaudit = await run(NODE_BIN, [NORMWIND_BIN, "Composite.vue"], { cwd: dir });
        assert(reaudit.exitCode === 0, `fix-then-audit did not converge (exit ${reaudit.exitCode})`);
    } finally {
        await rmrf(dir);
    }
});

addCheck("markup formats beyond Vue are scanned and fixed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-markup-"));
    try {
        const files = {
            "A.svelte": '<div class="px-4 py-4">s</div>\n<script lang="ts">let x: number = 1;</script>\n',
            "B.astro": '---\nconst t = "x";\n---\n<div class="mt-2 mb-2">a</div>\n',
            "C.html": '<html><body><div class="pl-3 pr-3">h</div></body></html>\n',
        };
        for (const [name, contents] of Object.entries(files)) {
            await fs.writeFile(path.join(dir, name), contents, "utf8");
        }

        const audit = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        const payload = parseCliJson(audit.stdout);
        assert(payload.lintedFiles === 3, `expected 3 linted files, got ${payload.lintedFiles}`);
        assert(payload.findingCount === 3, `expected 3 findings, got ${payload.findingCount}`);

        await run(NODE_BIN, [NORMWIND_BIN, "--fix"], { cwd: dir });
        assert((await fs.readFile(path.join(dir, "A.svelte"), "utf8")).includes('class="p-4"'), "svelte not fixed");
        assert((await fs.readFile(path.join(dir, "B.astro"), "utf8")).includes('class="my-2"'), "astro not fixed");
        assert((await fs.readFile(path.join(dir, "C.html"), "utf8")).includes('class="px-3"'), "html not fixed");
    } finally {
        await rmrf(dir);
    }
});

addCheck("class-string builders (clsx/cva/tv) are extracted", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-builders-"));
    try {
        const file = path.join(dir, "Variants.tsx");
        await fs.writeFile(
            file,
            [
                'import { cva } from "class-variance-authority";',
                'import clsx from "clsx";',
                'const button = cva("inline-flex px-4 py-4", {',
                '  variants: { size: { lg: "mt-3 mb-3" } },',
                '  defaultVariants: { size: "lg" },',
                '});',
                'const extra = clsx("gap-x-2 gap-y-2", cond && "ml-5 mr-5");',
                'const notClasses = clsx("hello world", "some-id");',
                "",
            ].join("\n"),
            "utf8",
        );

        const audit = await run(NODE_BIN, [NORMWIND_BIN, "--json", "Variants.tsx"], { cwd: dir });
        const payload = parseCliJson(audit.stdout);
        assert(payload.findingCount === 4, `expected 4 builder findings, got ${payload.findingCount}`);

        await run(NODE_BIN, [NORMWIND_BIN, "--fixall", "Variants.tsx"], { cwd: dir });
        const after = await fs.readFile(file, "utf8");
        assert(after.includes('cva("inline-flex p-4"'), `cva base string not fixed\n${after}`);
        assert(after.includes('lg: "my-3"'), `cva variant string not fixed\n${after}`);
        assert(after.includes('clsx("gap-2", cond && "mx-5")'), `clsx args not fixed\n${after}`);
        // Variant KEYS and non-class strings must survive untouched.
        assert(after.includes('defaultVariants: { size: "lg" }'), "variant key was rewritten");
        assert(after.includes('clsx("hello world", "some-id")'), "non-class strings were rewritten");
    } finally {
        await rmrf(dir);
    }
});

addCheck("reporters, --ignore and empty-match exit codes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-cli-surface-"));
    try {
        await fs.mkdir(path.join(dir, "src"), { recursive: true });
        await fs.mkdir(path.join(dir, "legacy"), { recursive: true });
        await fs.writeFile(path.join(dir, "src", "A.vue"), '<template><div class="px-4 py-4">a</div></template>\n', "utf8");
        await fs.writeFile(path.join(dir, "legacy", "B.vue"), '<template><div class="mt-2 mb-2">b</div></template>\n', "utf8");

        // SARIF
        const sarifRun = await run(NODE_BIN, [NORMWIND_BIN, "--reporter", "sarif"], { cwd: dir });
        const sarif = JSON.parse(sarifRun.stdout);
        assert(sarif.version === "2.1.0", "SARIF version must be 2.1.0");
        assert(sarif.runs?.[0]?.tool?.driver?.name === "NormWind", "SARIF driver name is wrong");
        assert(sarif.runs[0].results.length === 2, `expected 2 SARIF results, got ${sarif.runs[0].results.length}`);
        const location = sarif.runs[0].results[0].locations[0].physicalLocation;
        assert(typeof location.artifactLocation.uri === "string", "SARIF result has no artifact uri");
        assert(Number.isInteger(location.region.startLine), "SARIF result has no start line");

        // An unknown reporter is a usage error, not a silent fallback.
        const badReporter = await run(NODE_BIN, [NORMWIND_BIN, "--reporter", "xml"], { cwd: dir });
        assert(badReporter.exitCode === 2, `unknown --reporter must exit 2, got ${badReporter.exitCode}`);

        // --ignore removes a path from the scan.
        const ignored = await run(NODE_BIN, [NORMWIND_BIN, "--json", "--ignore", "legacy"], { cwd: dir });
        assert(parseCliJson(ignored.stdout).findingCount === 1, "--ignore did not exclude the legacy directory");

        // ...and so does a .normwindignore file.
        await fs.writeFile(path.join(dir, ".normwindignore"), "# comment\nlegacy/\n", "utf8");
        const ignoreFile = await run(NODE_BIN, [NORMWIND_BIN, "--json"], { cwd: dir });
        assert(parseCliJson(ignoreFile.stdout).findingCount === 1, ".normwindignore was not honored");
        await fs.rm(path.join(dir, ".normwindignore"));

        // A pattern that matches nothing is a usage error, not a clean run:
        // a typo'd CI path used to go green having scanned zero files.
        const empty = await run(NODE_BIN, [NORMWIND_BIN, "src/**/*.svelte"], { cwd: dir });
        assert(empty.exitCode === 2, `empty match must exit 2, got ${empty.exitCode}`);
        const emptyAllowed = await run(NODE_BIN, [NORMWIND_BIN, "src/**/*.svelte", "--allow-empty"], { cwd: dir });
        assert(emptyAllowed.exitCode === 0, `--allow-empty must exit 0, got ${emptyAllowed.exitCode}`);

        // Flag combinations that used to be silently dropped.
        for (const args of [["--fix", "--check-canonical"], ["--dry-run"]]) {
            const result = await run(NODE_BIN, [NORMWIND_BIN, ...args], { cwd: dir });
            assert(result.exitCode === 2, `${args.join(" ")} must exit 2, got ${result.exitCode}`);
        }
    } finally {
        await rmrf(dir);
    }
});

addCheck("packed tarball installs and runs as a consumer", async () => {
    // Everything else drives bin/normwind.mjs straight out of the checkout,
    // which is a different resolution root than what `npm i -g` produces.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-consumer-"));
    let packedTarball = null;
    const npm = (args) => (process.platform === "win32"
        ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd: dir })
        : run("npm", args, { cwd: dir }));
    try {
        // `npm pack` writes into the current directory. --pack-destination is
        // avoided deliberately: it is not honored consistently across npm
        // versions and sandboxed environments, whereas packing into REPO_ROOT
        // and moving the tarball works everywhere. finally removes it.
        const packed = process.platform === "win32"
            ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm pack --silent"])
            : await run("npm", ["pack", "--silent"]);
        assert(packed.ok, `npm pack failed\n${packed.stdout}\n${packed.stderr}`);
        const tarball = packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
        assert(tarball, "npm pack printed no tarball name");
        packedTarball = path.join(dir, tarball);
        // copy + unlink, not rename: the repo and the OS temp dir are routinely
        // on different volumes (EXDEV), which is the normal case on Windows.
        await fs.copyFile(path.join(REPO_ROOT, tarball), packedTarball);
        await fs.rm(path.join(REPO_ROOT, tarball), { force: true });

        await fs.writeFile(
            path.join(dir, "package.json"),
            JSON.stringify({ name: "normwind-consumer", version: "1.0.0", private: true }),
            "utf8",
        );
        // The tarball now sits in `dir`, which is also the install cwd, so a
        // bare filename avoids every quoting difference between cmd.exe and sh.
        const install = await npm(["install", "--no-audit", "--no-fund", "--silent", tarball]);
        assert(install.ok, `installing the tarball failed\n${install.stdout}\n${install.stderr}`);

        await fs.writeFile(path.join(dir, "App.vue"), '<template><div class="px-4 py-4">x</div></template>\n', "utf8");
        // npm created its own launcher shims; their existence is npm's contract,
        // not ours. What this check really proves is that the `files` allowlist
        // ships everything the CLI needs at runtime and that its dependencies
        // resolve from an installed location, so drive the installed entry
        // point directly with node instead of fighting shell quoting.
        const shimName = process.platform === "win32" ? "normwind.cmd" : "normwind";
        const shimExists = await fs
            .access(path.join(dir, "node_modules", ".bin", shimName))
            .then(() => true)
            .catch(() => false);
        assert(shimExists, `npm did not create a ${shimName} shim for the installed package`);

        const installedEntry = path.join(dir, "node_modules", "@lunawerx", "normwind", "bin", "normwind.mjs");
        const audit = await run(NODE_BIN, [installedEntry, "--json", "App.vue"], { cwd: dir });
        assert(
            audit.stdout.trim().startsWith("{"),
            `installed CLI produced no JSON (exit ${audit.exitCode})
STDOUT: ${audit.stdout}
STDERR: ${audit.stderr}`,
        );
        const payload = parseCliJson(audit.stdout);
        assert(payload.findingCount === 1, `installed CLI reported ${payload.findingCount} findings, expected 1`);
        assert(payload.findings[0].message.includes("p-4"), "installed CLI produced the wrong suggestion");
    } finally {
        // Never leave a tarball behind in the repo, even if the check threw
        // between `npm pack` and the rename.
        for (const entry of await fs.readdir(REPO_ROOT).catch(() => [])) {
            if (entry.endsWith(".tgz")) {
                await fs.rm(path.join(REPO_ROOT, entry), { force: true }).catch(() => {});
            }
        }
        await rmrf(dir);
    }
});

addCheck("lockfiles agree on dependency versions", async () => {
    // package-lock.json is what `npm ci` (and therefore CI and the release
    // workflow) installs from; bun.lock is what local development uses. A
    // dependency bumped through one package manager must not leave the other
    // silently pinned to the old version.
    //
    // Dependabot only ever updates package.json + package-lock.json, so every
    // one of its PRs lands here red until someone runs `npm run deps:sync`.
    // That is the intended workflow, not a bug in this check -- see the
    // "Updating dependencies" section of the README.
    const pkg = await readJson(path.join(REPO_ROOT, "package.json"));
    const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const bunLock = await fs.readFile(path.join(REPO_ROOT, "bun.lock"), "utf8").catch(() => null);
    if (bunLock === null) {
        return;
    }
    const npmLock = await readJson(path.join(REPO_ROOT, "package-lock.json"));

    for (const [name, range] of Object.entries(declared)) {
        const exact = /^\d/.test(range) ? range : null;
        if (!exact) {
            continue;
        }
        assert(
            bunLock.includes(`"${name}@${exact}"`),
            `bun.lock does not pin ${name}@${exact}; run \`npm run deps:sync\` and commit bun.lock (and dist/, if it changed)`,
        );
        const entry = npmLock.packages?.[`node_modules/${name}`];
        assert(
            entry?.version === exact,
            `package-lock.json pins ${name}@${entry?.version ?? "nothing"} but package.json declares ${exact}`,
        );
    }
});

addCheck("lockfiles agree on the whole resolved tree", async () => {
    // The check above only covers dependencies DECLARED in package.json. That is
    // not enough: a security bump usually lands on a transitive package, which no
    // declared-dependency check can see.
    //
    // The case that motivated this: nanoid reached us via
    // eslint-plugin-tailwindcss -> postcss. `npm audit fix` bumped it to 3.3.18 in
    // package-lock.json, and bun.lock stayed on the vulnerable 3.3.16 -- silently,
    // because `bun install` leaves an already-satisfying pin alone and 3.3.16
    // satisfies postcss's `^3.3.16`. Fixing a vulnerability for `npm ci` while
    // leaving `bun install` on the vulnerable copy is exactly the drift these two
    // lockfiles exist to make visible, so compare the FULL resolved set.
    //
    // Compared as a set of name@version pairs rather than per-path, because the two
    // package managers describe nesting differently: npm writes
    // `node_modules/mlly/node_modules/confbox` where bun writes
    // `mlly/pkg-types/confbox`. Both currently resolve confbox 0.2.4 at the top
    // level and 0.1.8 nested, and comparing paths would call that a disagreement
    // when the installed trees are identical.
    //
    // Non-registry versions (git/file/link specifiers) are skipped, matching the
    // `/^\d/` convention used by the declared-dependency check above.
    const bunLockRaw = await fs.readFile(path.join(REPO_ROOT, "bun.lock"), "utf8").catch(() => null);
    if (bunLockRaw === null) {
        return;
    }
    const npmLock = await readJson(path.join(REPO_ROOT, "package-lock.json"));

    const npmPairs = new Set();
    const NODE_MODULES = "node_modules/";
    for (const [entryPath, meta] of Object.entries(npmLock.packages ?? {})) {
        if (!entryPath.startsWith(NODE_MODULES) || meta?.link) {
            continue;
        }
        const version = meta?.version;
        if (typeof version !== "string" || !/^\d/.test(version)) {
            continue;
        }
        const name = entryPath.slice(entryPath.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
        npmPairs.add(`${name}@${version}`);
    }

    const bunPairs = new Set();
    const bunEntry = /"[^"]+"\s*:\s*\[\s*"((?:@[^"@/]+\/)?[^"@/]+)@([0-9][^"]*)"/g;
    for (const match of bunLockRaw.matchAll(bunEntry)) {
        bunPairs.add(`${match[1]}@${match[2]}`);
    }

    // A parser that silently matches nothing would make this check pass on every
    // possible input, which is worse than not having it at all.
    assert(
        npmPairs.size > 0 && bunPairs.size > 0,
        `lockfile parsing produced an empty set (npm: ${npmPairs.size}, bun: ${bunPairs.size}); the parser is broken, not the lockfiles`,
    );

    const npmOnly = [...npmPairs].filter((pair) => !bunPairs.has(pair)).sort();
    const bunOnly = [...bunPairs].filter((pair) => !npmPairs.has(pair)).sort();
    const detail = [
        npmOnly.length ? `only in package-lock.json: ${npmOnly.join(", ")}` : null,
        bunOnly.length ? `only in bun.lock: ${bunOnly.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    assert(
        npmOnly.length === 0 && bunOnly.length === 0,
        `lockfiles resolve different trees (${detail}). For a declared dependency run `
        + "`npm run deps:sync`; for a transitive one (a security bump, typically) bun needs to be "
        + "told explicitly, e.g. `bun update <name>`, because `bun install` will not move a pin "
        + "that still satisfies its range.",
    );
});

addCheck("npm pack dry-run", async () => {
    const result = process.platform === "win32"
        ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm pack --dry-run --json --silent"])
        : await run("npm", ["pack", "--dry-run", "--json", "--silent"]);
    assert(result.ok, `npm pack dry-run failed\n${result.stdout}\n${result.stderr}`);
    const packs = JSON.parse(result.stdout);
    const files = new Set((packs[0]?.files ?? []).map((f) => f.path));
    assert(files.has("bin/normwind.mjs"), "pack is missing bin/normwind.mjs");
    // Every lib/ module bin/normwind.mjs imports must ship, or the installed
    // CLI dies on its first import. The consumer-install check above proves
    // this end-to-end; this one names the missing file when it regresses.
    const libModules = (await fs.readdir(path.join(REPO_ROOT, "lib"))).filter((f) => f.endsWith(".mjs"));
    assert(libModules.length > 0, "lib/ has no modules; the split was reverted without updating this check");
    for (const moduleName of libModules) {
        assert(files.has(`lib/${moduleName}`), `pack is missing lib/${moduleName}`);
    }
    assert(files.has("docs/reference/canonical-replacements.json"), "pack is missing canonical JSON snapshot");
    assert(files.has("docs/reference/canonical-replacements.md"), "pack is missing canonical MD snapshot");
    assert(files.has("README.md"), "pack is missing README.md");
    assert(!files.has("scripts/test-regression.mjs"), "pack should not include test scripts");
    assert(!files.has("test/fixtures/family-shorthand/input.tsx"), "pack should not include test fixtures");
    const stragglers = [...files].filter((f) => /\.(bak|orig|swp|tmp)$/i.test(f));
    assert(stragglers.length === 0, `pack must not contain editor/refactor backups: ${stragglers.join(", ")}`);
});

async function main() {
    let failed = 0;
    for (const check of checks) {
        const started = Date.now();
        try {
            await check.fn();
            const ms = Date.now() - started;
            console.log(`[PASS] ${check.name} (${ms}ms)`);
        } catch (err) {
            failed += 1;
            console.log(`[FAIL] ${check.name}`);
            console.log(`  ${err.message}`);
        }
    }

    console.log("");
    console.log(`${checks.length} checks, ${failed} failures.`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
    console.error("prepush: fatal error");
    console.error(err);
    process.exitCode = 2;
});
