#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { escapeHtml, scannerEnvironment } from "../action/index.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACTION_ENTRY = path.join(REPO_ROOT, "dist", "index.mjs");
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "build-action.mjs");

const checks = [];

function addCheck(name, fn) {
    checks.push({ name, fn });
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function run(command, args, options = {}) {
    try {
        const result = await execFileAsync(command, args, {
            cwd: REPO_ROOT,
            env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(options.env ?? {}) },
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true,
            ...options,
        });
        return { exitCode: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    } catch (error) {
        if (typeof error?.code === "number") {
            return {
                exitCode: error.code,
                stdout: error.stdout ?? "",
                stderr: error.stderr ?? "",
            };
        }
        throw error;
    }
}

function parseOutputFile(text) {
    const outputs = {};
    const lines = text.replaceAll("\r\n", "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const match = /^([^<]+)<<(.+)$/.exec(lines[index]);
        if (!match) {
            continue;
        }
        const [, name, delimiter] = match;
        const values = [];
        index += 1;
        while (index < lines.length && lines[index] !== delimiter) {
            values.push(lines[index]);
            index += 1;
        }
        outputs[name] = values.join("\n");
    }
    return outputs;
}

async function runAction({ files, outsideFiles = {}, inputs = {}, workspaceName = "workspace" }) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-action-test-"));
    const workspace = path.join(tempRoot, workspaceName);
    const runnerTemp = path.join(tempRoot, "runner-temp");
    const outputFile = path.join(tempRoot, "github-output.txt");
    const summaryFile = path.join(tempRoot, "github-summary.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(runnerTemp, { recursive: true });
    await fs.writeFile(outputFile, "", "utf8");
    await fs.writeFile(summaryFile, "", "utf8");
    for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(workspace, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents, "utf8");
    }
    for (const [relative, contents] of Object.entries(outsideFiles)) {
        const target = path.join(tempRoot, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents, "utf8");
    }

    const inputEnv = Object.fromEntries(
        Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, String(value)]),
    );
    const result = await run(process.execPath, [ACTION_ENTRY], {
        cwd: workspace,
        env: {
            GITHUB_ACTION_PATH: REPO_ROOT,
            GITHUB_OUTPUT: outputFile,
            GITHUB_STEP_SUMMARY: summaryFile,
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: runnerTemp,
            ...inputEnv,
        },
    });
    const [outputText, summary] = await Promise.all([
        fs.readFile(outputFile, "utf8"),
        fs.readFile(summaryFile, "utf8"),
    ]);
    return {
        ...result,
        outputs: parseOutputFile(outputText),
        summary,
        tempRoot,
        workspace,
        cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
    };
}

const FINDING_SOURCE = `<template>\n  <div class="px-4 py-4">Finding</div>\n</template>\n`;
const CLEAN_SOURCE = `<template>\n  <div class="p-4">Clean</div>\n</template>\n`;

addCheck("committed bundle is current", async () => {
    const result = await run(process.execPath, [BUILD_SCRIPT, "--check"]);
    assert(result.exitCode === 0, `${result.stdout}\n${result.stderr}`);
    assert(result.stdout.includes("Action bundle is up to date."), result.stdout);
});

addCheck("job-summary HTML is escaped", async () => {
    assert(
        escapeHtml(`<script data-x="'">&</script>`)
            === "&lt;script data-x=&quot;&#39;&quot;&gt;&amp;&lt;/script&gt;",
        "summary content must be HTML-escaped",
    );
});

addCheck("scanner child environment strips GitHub tokens and arbitrary secrets", async () => {
    const previousToken = process.env.GITHUB_TOKEN;
    const previousSecret = process.env.TEST_NORMWIND_SECRET;
    process.env.GITHUB_TOKEN = "must-not-cross-process-boundary";
    process.env.TEST_NORMWIND_SECRET = "must-not-cross-process-boundary";
    try {
        const environment = scannerEnvironment(REPO_ROOT);
        assert(!Object.hasOwn(environment, "GITHUB_TOKEN"), "scanner inherited GITHUB_TOKEN");
        assert(!Object.hasOwn(environment, "TEST_NORMWIND_SECRET"), "scanner inherited an arbitrary secret");
        assert(environment.NORMWIND_FORCE_BUNDLED_RUNTIME === "1", "scanner must force bundled dependencies");
        assert(environment.NORMWIND_DISABLE_RIPGREP === "1", "scanner must not execute a checkout-provided rg binary");
        assert(environment.NORMWIND_DISABLE_DISK_CACHE === "1", "scanner must not write its cache into the checkout");
    } finally {
        if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previousToken;
        if (previousSecret === undefined) delete process.env.TEST_NORMWIND_SECRET;
        else process.env.TEST_NORMWIND_SECRET = previousSecret;
    }
});

addCheck("checked-out dependencies are never executed", async () => {
    const runResult = await runAction({
        files: {
            "src/Arbitrary.vue": `<template>\n  <div class="rounded-[24px]">Safe</div>\n</template>\n`,
            "node_modules/tailwindcss/package.json": JSON.stringify({
                name: "tailwindcss",
                version: "4.3.3",
                main: "index.js",
            }),
            "node_modules/tailwindcss/index.js": [
                'require("node:fs").writeFileSync(',
                '  require("node:path").join(process.cwd(), "MALICIOUS_DEPENDENCY_EXECUTED"),',
                '  "executed",',
                ');',
                "module.exports = {};",
                "",
            ].join("\n"),
            "docs/reference/canonical-replacements.json": JSON.stringify({
                source: { tailwindVersion: "4.3.3" },
                replacements: [
                    { inputClass: "rounded-[24px]", canonicalClass: "checkout-controlled-value" },
                ],
            }),
        },
        inputs: { "FAIL-ON-FINDINGS": "false" },
    });
    try {
        assert(runResult.exitCode === 0, `${runResult.stdout}\n${runResult.stderr}`);
        assert(runResult.outputs.result === "findings", JSON.stringify(runResult.outputs));
        assert(runResult.summary.includes("rounded-3xl"), runResult.summary);
        assert(!runResult.summary.includes("checkout-controlled-value"), runResult.summary);
        const sentinel = path.join(runResult.workspace, "MALICIOUS_DEPENDENCY_EXECUTED");
        assert(!(await fs.stat(sentinel).then(() => true).catch(() => false)), "checked-out dependency executed");
        const cachePath = path.join(runResult.workspace, "node_modules", ".cache", "normwinds");
        assert(!(await fs.stat(cachePath).then(() => true).catch(() => false)), "Action wrote a scanner cache into the checkout");
    } finally {
        await runResult.cleanup();
    }
});

addCheck("bundled Tailwind supports workspace-confined theme imports", async () => {
    const runResult = await runAction({
        files: {
            "src/Theme.vue": `<template>\n  <div class="border-(--md-sys-color-outline-variant)"></div>\n</template>\n`,
            "styles/theme.css": "@import './tokens.css';\n",
            "styles/tokens.css": "@theme { --color-outline-variant: var(--md-sys-color-outline-variant); }\n",
        },
        inputs: {
            "THEME-CSS": "styles/theme.css",
            "SUGGEST-NAMED-THEME-VARS": "true",
            "FAIL-ON-FINDINGS": "false",
        },
    });
    try {
        assert(runResult.exitCode === 0, `${runResult.stdout}\n${runResult.stderr}`);
        assert(runResult.outputs.result === "findings", JSON.stringify(runResult.outputs));
        assert(runResult.summary.includes("border-outline-variant"), runResult.summary);
    } finally {
        await runResult.cleanup();
    }
});

addCheck("findings fail with annotations, outputs, summary, and report", async () => {
    const runResult = await runAction({
        files: { "src/Needs work.vue": FINDING_SOURCE },
        inputs: {
            "WORKING-DIRECTORY": ".",
            PATTERNS: "src/Needs work.vue",
            "FAIL-ON-FINDINGS": "true",
            "MAX-ANNOTATIONS": "10",
        },
        workspaceName: "workspace with spaces",
    });
    try {
        assert(runResult.exitCode === 1, `expected Action failure, got ${runResult.exitCode}\n${runResult.stdout}\n${runResult.stderr}`);
        assert(runResult.outputs.result === "findings", JSON.stringify(runResult.outputs));
        assert(runResult.outputs["finding-count"] === "1", JSON.stringify(runResult.outputs));
        assert(runResult.outputs["linted-files"] === "1", JSON.stringify(runResult.outputs));
        assert(runResult.outputs["exit-code"] === "1", JSON.stringify(runResult.outputs));
        assert(runResult.stdout.includes("::warning"), runResult.stdout);
        assert(runResult.stdout.includes("src/Needs work.vue"), runResult.stdout);
        assert(runResult.summary.includes("NormWind Tailwind audit"), runResult.summary);
        assert(runResult.summary.includes("Suggested normalization"), runResult.summary);
        const report = JSON.parse(await fs.readFile(runResult.outputs["report-path"], "utf8"));
        assert(report.findingCount === 1, JSON.stringify(report));
    } finally {
        await runResult.cleanup();
    }
});

addCheck("advisory findings succeed and respect annotation cap", async () => {
    const runResult = await runAction({
        files: {
            "src/One.vue": FINDING_SOURCE,
            "src/Two.vue": FINDING_SOURCE.replace("Finding", "Two"),
        },
        inputs: {
            "FAIL-ON-FINDINGS": "false",
            "MAX-ANNOTATIONS": "1",
        },
    });
    try {
        assert(runResult.exitCode === 0, `${runResult.stdout}\n${runResult.stderr}`);
        assert(runResult.outputs.result === "findings", JSON.stringify(runResult.outputs));
        assert(runResult.outputs["finding-count"] === "2", JSON.stringify(runResult.outputs));
        assert((runResult.stdout.match(/::warning/g) ?? []).length === 1, runResult.stdout);
        assert(runResult.stdout.includes("::notice"), runResult.stdout);
        assert(runResult.summary.includes("1 finding(s) were reported only in this summary"), runResult.summary);
    } finally {
        await runResult.cleanup();
    }
});

addCheck("clean audit succeeds", async () => {
    const runResult = await runAction({ files: { "src/Clean.vue": CLEAN_SOURCE } });
    try {
        assert(runResult.exitCode === 0, `${runResult.stdout}\n${runResult.stderr}`);
        assert(runResult.outputs.result === "clean", JSON.stringify(runResult.outputs));
        assert(runResult.outputs["finding-count"] === "0", JSON.stringify(runResult.outputs));
        assert(runResult.outputs["exit-code"] === "0", JSON.stringify(runResult.outputs));
        assert(!runResult.stdout.includes("::warning"), runResult.stdout);
    } finally {
        await runResult.cleanup();
    }
});

addCheck("runtime errors stay fatal in advisory mode", async () => {
    const runResult = await runAction({
        files: {
            "src/Broken.tsx": [
                "export const broken = (;",
                '// <div className="px-4 py-4">must never be rewritten</div>',
                "",
            ].join("\n"),
        },
        inputs: { "FAIL-ON-FINDINGS": "false" },
    });
    try {
        assert(runResult.exitCode === 1, `expected fatal Action result\n${runResult.stdout}\n${runResult.stderr}`);
        assert(runResult.outputs.result === "error", JSON.stringify(runResult.outputs));
        assert(runResult.outputs["exit-code"] === "2", JSON.stringify(runResult.outputs));
        assert(runResult.stdout.includes("failed:parse"), runResult.stdout);
    } finally {
        await runResult.cleanup();
    }
});

addCheck("invalid inputs and workspace escapes fail closed", async () => {
    const invalidBoolean = await runAction({
        files: { "src/Clean.vue": CLEAN_SOURCE },
        inputs: { "FAIL-ON-FINDINGS": "sometimes" },
    });
    try {
        assert(invalidBoolean.exitCode === 1, invalidBoolean.stdout);
        assert(invalidBoolean.outputs.result === "error", JSON.stringify(invalidBoolean.outputs));
        assert(invalidBoolean.stdout.includes("must be true or false"), invalidBoolean.stdout);
    } finally {
        await invalidBoolean.cleanup();
    }

    const outsideWorkspace = await runAction({
        files: { "src/Clean.vue": CLEAN_SOURCE },
        inputs: { "WORKING-DIRECTORY": ".." },
    });
    try {
        assert(outsideWorkspace.exitCode === 1, outsideWorkspace.stdout);
        assert(outsideWorkspace.outputs.result === "error", JSON.stringify(outsideWorkspace.outputs));
        assert(outsideWorkspace.stdout.includes("must stay inside GITHUB_WORKSPACE"), outsideWorkspace.stdout);
    } finally {
        await outsideWorkspace.cleanup();
    }

    const outsidePattern = await runAction({
        files: { "src/Clean.vue": CLEAN_SOURCE },
        inputs: { PATTERNS: "../outside.tsx" },
    });
    try {
        assert(outsidePattern.exitCode === 1, outsidePattern.stdout);
        assert(outsidePattern.outputs.result === "error", JSON.stringify(outsidePattern.outputs));
        assert(outsidePattern.stdout.includes("must stay inside the working directory"), outsidePattern.stdout);
    } finally {
        await outsidePattern.cleanup();
    }

    const outsideTheme = await runAction({
        files: { "src/Clean.vue": CLEAN_SOURCE },
        outsideFiles: { "outside.css": "@theme { --color-test: red; }\n" },
        inputs: { "THEME-CSS": "../outside.css" },
    });
    try {
        assert(outsideTheme.exitCode === 1, outsideTheme.stdout);
        assert(outsideTheme.outputs.result === "error", JSON.stringify(outsideTheme.outputs));
        assert(outsideTheme.stdout.includes("must stay inside GITHUB_WORKSPACE"), outsideTheme.stdout);
    } finally {
        await outsideTheme.cleanup();
    }
});

addCheck("sarif-file and ignore inputs", async () => {
    const runResult = await runAction({
        files: {
            "src/Bad.vue": FINDING_SOURCE,
            "legacy/Old.vue": FINDING_SOURCE.replace("Finding", "Old"),
        },
        inputs: {
            "FAIL-ON-FINDINGS": "false",
            IGNORE: "legacy",
            "SARIF-FILE": "reports/normwind.sarif",
        },
    });
    try {
        assert(runResult.exitCode === 0, `${runResult.stdout}\n${runResult.stderr}`);
        assert(runResult.outputs["finding-count"] === "1", `ignore input was not applied: ${JSON.stringify(runResult.outputs)}`);
        const sarifPath = runResult.outputs["sarif-path"];
        assert(sarifPath, "sarif-path output was not set");
        const sarif = JSON.parse(await fs.readFile(sarifPath, "utf8"));
        assert(sarif.version === "2.1.0", "SARIF version must be 2.1.0");
        assert(sarif.runs[0].results.length === 1, `expected 1 SARIF result, got ${sarif.runs[0].results.length}`);
        assert(
            sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri.includes("Bad.vue"),
            "SARIF result points at the wrong file",
        );
    } finally {
        await runResult.cleanup();
    }

    const escaping = await runAction({
        files: { "src/Clean.vue": CLEAN_SOURCE },
        inputs: { "SARIF-FILE": "../escape.sarif" },
    });
    try {
        assert(escaping.exitCode === 1, escaping.stdout);
        assert(escaping.outputs.result === "error", JSON.stringify(escaping.outputs));
        assert(escaping.stdout.includes("must stay inside"), escaping.stdout);
    } finally {
        await escaping.cleanup();
    }
});

// The Action's first line of defence lives in action/index.mjs and is covered
// above. These checks exercise the SECOND line: the NORMWIND_ACTION_WORKSPACE
// guards inside the scanner itself (assertInsideActionWorkspace,
// resolveActionSafePath, validateActionPattern, the directory-symlink refusals).
// Those are what stop a hostile checkout that gets a path past the wrapper, and
// nothing used to test them at all.
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "normwind.mjs");

async function runScannerInWorkspace(args, { workspace, cwd = workspace }) {
    return run(process.execPath, [CLI_ENTRY, ...args], {
        cwd,
        env: {
            NORMWIND_ACTION_WORKSPACE: workspace,
            NORMWIND_DISABLE_DISK_CACHE: "1",
            NORMWIND_DISABLE_RIPGREP: "1",
            NORMWIND_FORCE_BUNDLED_RUNTIME: "1",
            NORMWIND_BUNDLED_TAILWIND_CSS: path.join(REPO_ROOT, "dist", "tailwindcss-index.css"),
        },
    });
}

async function trySymlink(target, linkPath, type) {
    try {
        await fs.symlink(target, linkPath, type);
        return true;
    } catch {
        // Windows needs Developer Mode or elevation for symlinks. Skipping is
        // correct there; Linux and macOS CI still cover these paths.
        return false;
    }
}

addCheck("scanner refuses paths that escape the Action workspace", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-action-escape-"));
    const workspace = path.join(tempRoot, "workspace");
    try {
        await fs.mkdir(path.join(workspace, "src"), { recursive: true });
        await fs.writeFile(path.join(workspace, "src", "A.vue"), CLEAN_SOURCE, "utf8");
        await fs.writeFile(path.join(tempRoot, "outside.css"), "@theme { --color-x: red; }\n", "utf8");
        await fs.writeFile(path.join(tempRoot, "Outside.vue"), FINDING_SOURCE, "utf8");

        // A traversing pattern must never be scanned.
        const traversal = await runScannerInWorkspace(["../Outside.vue", "--json"], { workspace });
        assert(traversal.exitCode === 2, `traversal pattern should exit 2, got ${traversal.exitCode}`);
        assert(
            /must stay inside the working directory/.test(traversal.stderr),
            `expected a workspace-escape error, got: ${traversal.stderr}`,
        );

        // An absolute path outside the workspace, likewise.
        const absolute = await runScannerInWorkspace([path.join(tempRoot, "Outside.vue"), "--json"], { workspace });
        assert(absolute.exitCode === 2, `absolute outside path should exit 2, got ${absolute.exitCode}`);

        // A theme CSS entry that only escapes once resolved through a symlink
        // has to be caught by realpath, not by string inspection.
        const linkedTheme = path.join(workspace, "theme.css");
        if (await trySymlink(path.join(tempRoot, "outside.css"), linkedTheme, "file")) {
            const themeEscape = await runScannerInWorkspace(
                ["src/A.vue", "--json", "--theme-css", "theme.css"],
                { workspace },
            );
            assert(themeEscape.exitCode === 2, `symlinked theme escape should exit 2, got ${themeEscape.exitCode}`);
            assert(
                /escapes the checked-out workspace/.test(themeEscape.stderr),
                `expected a realpath escape error, got: ${themeEscape.stderr}`,
            );
            await fs.rm(linkedTheme, { force: true });
        }

        // Directory symlinks are refused outright in Action mode, escaping or
        // not, because following one makes the scanned set unverifiable.
        const linkedDir = path.join(workspace, "linked");
        if (await trySymlink(path.join(tempRoot), linkedDir, "dir")) {
            const dirLink = await runScannerInWorkspace(["--json"], { workspace });
            assert(dirLink.exitCode === 2, `directory symlink should exit 2, got ${dirLink.exitCode}`);
            assert(
                /refuses directory symlink/.test(dirLink.stderr),
                `expected a directory-symlink refusal, got: ${dirLink.stderr}`,
            );
            await fs.rm(linkedDir, { force: true, recursive: true });
        }

        // The happy path still works with the guards armed.
        const clean = await runScannerInWorkspace(["src/A.vue", "--json"], { workspace });
        assert(clean.exitCode === 0, `guarded clean scan should exit 0, got ${clean.exitCode}\n${clean.stderr}`);
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

addCheck("Action mode ignores a checkout-supplied ignore file", async () => {
    // .normwindignore is checkout-controlled. Honoring it inside the Action
    // would let a pull request silence the audit on exactly the files it
    // changed, so the file is read only outside Action mode.
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "normwind-action-ignore-"));
    const workspace = path.join(tempRoot, "workspace");
    try {
        await fs.mkdir(path.join(workspace, "src"), { recursive: true });
        await fs.writeFile(path.join(workspace, "src", "Bad.vue"), FINDING_SOURCE, "utf8");
        await fs.writeFile(path.join(workspace, ".normwindignore"), "src/\n", "utf8");

        const guarded = await runScannerInWorkspace(["--json"], { workspace });
        const payload = JSON.parse(guarded.stdout.slice(guarded.stdout.indexOf("{")));
        assert(payload.findingCount === 1, `Action mode honored a checkout ignore file: ${guarded.stdout}`);

        // Outside Action mode the same file IS honored.
        const local = await run(process.execPath, [CLI_ENTRY, "--json"], {
            cwd: workspace,
            env: { NORMWIND_DISABLE_DISK_CACHE: "1", NORMWIND_DISABLE_RIPGREP: "1" },
        });
        const localPayload = JSON.parse(local.stdout.slice(local.stdout.indexOf("{")));
        assert(localPayload.findingCount === 0, `.normwindignore was not honored locally: ${local.stdout}`);
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

addCheck("theme suggestions require a theme entry", async () => {
    const runResult = await runAction({
        files: { "src/Clean.vue": CLEAN_SOURCE },
        inputs: { "SUGGEST-NAMED-THEME-VARS": "true" },
    });
    try {
        assert(runResult.exitCode === 1, runResult.stdout);
        assert(runResult.outputs.result === "error", JSON.stringify(runResult.outputs));
        assert(runResult.stdout.includes("requires"), runResult.stdout);
    } finally {
        await runResult.cleanup();
    }
});

async function main() {
    let failed = 0;
    for (const check of checks) {
        const started = Date.now();
        try {
            await check.fn();
            console.log(`[PASS] action: ${check.name} (${Date.now() - started}ms)`);
        } catch (error) {
            failed += 1;
            console.log(`[FAIL] action: ${check.name}`);
            console.log(`  ${error.message}`);
        }
    }
    console.log("");
    console.log(`${checks.length} action checks, ${failed} failures.`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
    console.error("test-action: fatal error");
    console.error(error);
    process.exitCode = 2;
});
