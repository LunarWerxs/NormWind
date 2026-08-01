import * as core from "@actions/core";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACTION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(ACTION_ROOT, "dist", "normwind.mjs");
const BUNDLED_TAILWIND_CSS = path.join(ACTION_ROOT, "dist", "tailwindcss-index.css");
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const ACTION_TIMEOUT_MS = 10 * 60 * 1_000;

function parseBooleanInput(name, fallback) {
    const raw = core.getInput(name).trim();
    if (!raw) {
        return fallback;
    }
    if (/^(true|yes|on|1)$/i.test(raw)) {
        return true;
    }
    if (/^(false|no|off|0)$/i.test(raw)) {
        return false;
    }
    throw new Error(`Input "${name}" must be true or false, received "${raw}".`);
}

function parseIntegerInput(name, fallback, { min, max }) {
    const raw = core.getInput(name).trim();
    if (!raw) {
        return fallback;
    }
    if (!/^\d+$/.test(raw)) {
        throw new Error(`Input "${name}" must be an integer between ${min} and ${max}.`);
    }
    const value = Number.parseInt(raw, 10);
    if (value < min || value > max) {
        throw new Error(`Input "${name}" must be between ${min} and ${max}, received ${value}.`);
    }
    return value;
}

function isInside(parent, child) {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveWorkingDirectory() {
    const workspaceInput = process.env.GITHUB_WORKSPACE?.trim() || process.cwd();
    const workspace = await fs.realpath(workspaceInput).catch(() => {
        throw new Error(`GITHUB_WORKSPACE does not exist: ${workspaceInput}`);
    });
    const requested = core.getInput("working-directory").trim() || ".";
    const candidate = path.resolve(workspace, requested);
    const workingDirectory = await fs.realpath(candidate).catch(() => {
        throw new Error(`Working directory does not exist: ${candidate}`);
    });
    const stat = await fs.stat(workingDirectory);
    if (!stat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${workingDirectory}`);
    }
    if (!isInside(workspace, workingDirectory)) {
        throw new Error(`Working directory must stay inside GITHUB_WORKSPACE: ${requested}`);
    }
    return { workspace, workingDirectory };
}

function parsePatterns() {
    const patterns = core
        .getMultilineInput("patterns")
        .map((value) => value.trim())
        .filter(Boolean);
    for (const pattern of patterns) {
        const segments = pattern.replaceAll("\\", "/").split("/");
        if (
            pattern.includes("\0")
            || path.isAbsolute(pattern)
            || path.win32.isAbsolute(pattern)
            || segments.includes("..")
        ) {
            throw new Error(`Input "patterns" must stay inside the working directory: ${pattern}`);
        }
    }
    return patterns;
}

async function resolveThemeCss(themeCss, { workspace, workingDirectory }) {
    if (!themeCss) {
        return "";
    }
    const candidate = path.resolve(workingDirectory, themeCss);
    const realPath = await fs.realpath(candidate).catch(() => {
        throw new Error(`Theme CSS entry does not exist: ${candidate}`);
    });
    if (!isInside(workspace, realPath)) {
        throw new Error(`Theme CSS entry must stay inside GITHUB_WORKSPACE: ${themeCss}`);
    }
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
        throw new Error(`Theme CSS entry is not a regular file: ${realPath}`);
    }
    return realPath;
}

function parseCliPayload(stdout) {
    const trimmed = String(stdout ?? "").trim();
    if (!trimmed) {
        throw new Error("NormWind returned no JSON report.");
    }
    let payload;
    try {
        payload = JSON.parse(trimmed);
    } catch {
        throw new Error("NormWind returned malformed JSON; the Action could not create annotations.");
    }
    if (
        !Number.isInteger(payload?.findingCount)
        || !Number.isInteger(payload?.lintedFiles)
        || !Array.isArray(payload?.findings)
        || typeof payload?.version !== "string"
    ) {
        throw new Error("NormWind returned an invalid report shape.");
    }
    return payload;
}

function normalizeFinding(finding, { workspace, workingDirectory }) {
    const originalPath = String(finding?.filePath ?? "");
    const absolutePath = path.resolve(workingDirectory, originalPath);
    const annotationPath = isInside(workspace, absolutePath)
        ? path.relative(workspace, absolutePath).replaceAll(path.sep, "/")
        : originalPath.replaceAll("\\", "/");
    const line = Number.isInteger(finding?.line) && finding.line > 0 ? finding.line : 1;
    const column = Number.isInteger(finding?.column) && finding.column > 0 ? finding.column : 1;
    return {
        file: annotationPath,
        line,
        column,
        message: String(finding?.message ?? "Tailwind class can be normalized."),
    };
}

export function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

export function scannerEnvironment(workspace) {
    const environment = {
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        NORMWIND_ACTION_WORKSPACE: workspace,
        NORMWIND_BUNDLED_TAILWIND_CSS: BUNDLED_TAILWIND_CSS,
        NORMWIND_DISABLE_DISK_CACHE: "1",
        NORMWIND_DISABLE_RIPGREP: "1",
        NORMWIND_FORCE_BUNDLED_RUNTIME: "1",
    };
    const preservedKeys = new Set([
        "APPDATA",
        "COMSPEC",
        "LOCALAPPDATA",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "WINDIR",
    ]);
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && preservedKeys.has(key.toUpperCase())) {
            environment[key] = value;
        }
    }
    return environment;
}

async function executeCli(args, workingDirectory, workspace) {
    try {
        const result = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
            cwd: workingDirectory,
            env: scannerEnvironment(workspace),
            maxBuffer: MAX_BUFFER_BYTES,
            timeout: ACTION_TIMEOUT_MS,
            windowsHide: true,
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

async function writeReport(payload) {
    const reportDirectory = process.env.RUNNER_TEMP?.trim() || os.tmpdir();
    await fs.mkdir(reportDirectory, { recursive: true });
    const reportPath = path.join(reportDirectory, `normwind-report-${process.pid}.json`);
    await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return reportPath;
}

async function writeSummary(payload, findings, exitCode, annotatedCount) {
    const result = exitCode === 0 ? "Clean" : exitCode === 1 ? "Findings" : "Incomplete";
    core.summary
        .addHeading("NormWind Tailwind audit", 2)
        .addTable([
            [
                { data: "Result", header: true },
                { data: "Files scanned", header: true },
                { data: "Findings", header: true },
                { data: "Version", header: true },
            ],
            [result, String(payload.lintedFiles), String(payload.findingCount), escapeHtml(payload.version)],
        ]);

    if (findings.length > 0) {
        const rows = findings.slice(0, 100).map((finding) => [
            `<code>${escapeHtml(finding.file)}</code>`,
            `${finding.line}:${finding.column}`,
            escapeHtml(finding.message),
        ]);
        core.summary.addHeading("Findings", 3).addTable([
            [
                { data: "File", header: true },
                { data: "Location", header: true },
                { data: "Suggested normalization", header: true },
            ],
            ...rows,
        ]);
        if (findings.length > rows.length) {
            core.summary.addRaw(`\n${findings.length - rows.length} additional finding(s) omitted from the summary.\n`);
        }
        if (findings.length > annotatedCount) {
            core.summary.addRaw(`\n${findings.length - annotatedCount} finding(s) were reported only in this summary.\n`);
        }
    }

    await core.summary.write();
}

function conciseError(stderr) {
    const text = String(stderr ?? "").trim();
    if (!text) {
        return "NormWind could not complete the audit.";
    }
    return text.length > 2_000 ? `${text.slice(0, 1_997)}...` : text;
}

export async function runAction() {
    try {
        const { workspace, workingDirectory } = await resolveWorkingDirectory();
        const patterns = parsePatterns();
        const failOnFindings = parseBooleanInput("fail-on-findings", true);
        const suggestNamedThemeVars = parseBooleanInput("suggest-named-theme-vars", false);
        const maxAnnotations = parseIntegerInput("max-annotations", 10, { min: 0, max: 50 });
        const themeCss = await resolveThemeCss(core.getInput("theme-css").trim(), {
            workspace,
            workingDirectory,
        });

        if (suggestNamedThemeVars && !themeCss) {
            throw new Error('Input "suggest-named-theme-vars" requires "theme-css".');
        }

        const args = [...patterns, "--json"];
        if (themeCss) {
            args.push("--theme-css", themeCss);
        }
        if (suggestNamedThemeVars) {
            args.push("--suggest-named-theme-vars");
        }

        core.info(`Running NormWind in ${workingDirectory}`);
        const execution = await executeCli(args, workingDirectory, workspace);
        if (execution.exitCode !== 0 && !String(execution.stdout).trim()) {
            throw new Error(conciseError(execution.stderr));
        }
        const payload = parseCliPayload(execution.stdout);
        const findings = payload.findings.map((finding) => normalizeFinding(finding, { workspace, workingDirectory }));
        const reportPath = await writeReport(payload);

        core.setOutput("version", payload.version);
        core.setOutput("finding-count", payload.findingCount);
        core.setOutput("linted-files", payload.lintedFiles);
        core.setOutput("exit-code", execution.exitCode);
        core.setOutput("report-path", reportPath);

        const annotatedCount = Math.min(findings.length, maxAnnotations);
        for (const finding of findings.slice(0, annotatedCount)) {
            core.warning(finding.message, {
                file: finding.file,
                startLine: finding.line,
                startColumn: finding.column,
            });
        }

        await writeSummary(payload, findings, execution.exitCode, annotatedCount);

        if (execution.exitCode === 2) {
            core.setOutput("result", "error");
            core.setFailed(conciseError(execution.stderr));
            return;
        }
        if (execution.exitCode !== 0 && execution.exitCode !== 1) {
            core.setOutput("result", "error");
            core.setFailed(`NormWind exited with unexpected code ${execution.exitCode}.`);
            return;
        }
        if (execution.exitCode === 0 && payload.findingCount !== 0) {
            core.setOutput("result", "error");
            core.setFailed("NormWind reported findings but exited successfully; refusing an inconsistent result.");
            return;
        }
        if (execution.exitCode === 1 && payload.findingCount === 0) {
            core.setOutput("result", "error");
            core.setFailed("NormWind exited for findings but returned an empty report; refusing an inconsistent result.");
            return;
        }

        if (payload.findingCount > 0) {
            core.setOutput("result", "findings");
            const message = `NormWind found ${payload.findingCount} normalization issue(s) across ${payload.lintedFiles} scanned file(s).`;
            if (failOnFindings) {
                core.setFailed(message);
            } else {
                core.notice(message);
            }
            return;
        }

        core.setOutput("result", "clean");
        core.info(`NormWind found no issues across ${payload.lintedFiles} scanned file(s).`);
    } catch (error) {
        core.setOutput("result", "error");
        core.setOutput("exit-code", 2);
        core.setFailed(error instanceof Error ? error.message : String(error));
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
    await runAction();
}
