// Which files a run scans.
//
// Ripgrep when it is present and a bounded fallback walker when it is not, held
// to the SAME ignore contract -- the rg globs are derived from the walker's own
// sets so the two cannot drift -- plus .normwindignore and the Action's hard
// caps on file count and total bytes.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { globPatternToRegExp, hasGlobSyntax } from "./glob.mjs";
import { FILE_SCAN_CONCURRENCY, runWithConcurrency } from "./concurrency.mjs";
import { DEFAULT_PATTERNS, MARKUP_EXTENSIONS } from "./scan-config.mjs";
import {
    ACTION_MAX_FILES,
    ACTION_MAX_TOTAL_SOURCE_BYTES,
    ACTION_WORKSPACE_ROOT,
    resolveActionSafePath,
} from "./workspace.mjs";

const execFileAsync = promisify(execFile);

// Directory names that are never hand-authored source, at ANY depth.
const IGNORED_SEGMENTS = new Set([
    ".git",
    ".venv",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".astro",
    ".turbo",
    "cdk.out",
    "dist",
    "node_modules",
    "storybook-static",
    "test-results",
]);
// Names that are conventionally build output at the project root but are
// perfectly ordinary source directory names further down (`src/lib/build/`,
// `app/components/out/`), so they are only ignored at the root.
const IGNORED_ROOT_PREFIXES = [
    ".cache/",
    ".tmp/",
    "build/",
    "coverage/",
    "dist/",
    "out/",
    "test-results/",
    "vendor/",
];
const IGNORED_EXACT_PATHS = new Set();

// The ripgrep glob list and the walkDirectory sets above must describe the
// SAME contract - rg additionally honors .gitignore, so anything that relies
// on .gitignore alone would silently diverge on machines without rg. Derive
// the globs from the sets so the two can never drift apart by hand.
const RG_IGNORE_GLOBS = [
    ...[...IGNORED_SEGMENTS].flatMap((segment) => [`!${segment}/**`, `!**/${segment}/**`]),
    ...IGNORED_ROOT_PREFIXES.map((prefix) => `!${prefix}**`),
    ...[...IGNORED_EXACT_PATHS].map((exact) => `!${exact}`),
];


function validateActionPattern(pattern) {
    if (!ACTION_WORKSPACE_ROOT) {
        return;
    }
    const normalized = pattern.replace(/\\/g, "/");
    const segments = normalized.split("/");
    if (
        pattern.includes("\0")
        || path.isAbsolute(pattern)
        || path.win32.isAbsolute(pattern)
        || segments.includes("..")
    ) {
        throw new Error(`normwinds: Action patterns must stay inside the working directory: ${pattern}`);
    }
}

function hasAllowedExtension(filePath) {
    return /\.(?:vue|svelte|astro|html|htm|js|mjs|cjs|ts|jsx|tsx|mts|cts)$/i.test(filePath);
}

function isMarkupFile(filePath) {
    return MARKUP_EXTENSIONS.has(path.extname(String(filePath ?? "")).toLowerCase());
}

function normalizeRelativePath(filePath) {
    return path.relative(process.cwd(), path.resolve(process.cwd(), filePath)).replace(/\\/g, "/");
}

const IGNORE_FILE_NAME = ".normwindignore";

// Extra ignore globs from --ignore and .normwindignore, compiled once.
let extraIgnoreMatchers = [];
let extraIgnoreGlobs = [];

function toIgnoreMatcher(pattern) {
    const trimmed = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!trimmed) {
        return null;
    }
    // A bare directory name means "everything under it", the way .gitignore
    // and every other ignore file people have used behaves.
    const expanded = hasGlobSyntax(trimmed)
        ? trimmed
        : `${trimmed.replace(/\/+$/, "")}/**`;
    return { glob: expanded, regex: globPatternToRegExp(expanded), bare: trimmed.replace(/\/+$/, "") };
}

async function loadIgnoreConfig(cliPatterns) {
    const patterns = [...cliPatterns];

    // The ignore FILE is checkout-controlled, so it is deliberately not read in
    // Action mode: a pull request could otherwise silence the audit on exactly
    // the files it changed. Explicit --ignore flags come from the workflow
    // author and are always honored.
    if (!ACTION_WORKSPACE_ROOT) {
        try {
            const raw = await fs.readFile(path.resolve(process.cwd(), IGNORE_FILE_NAME), "utf8");
            for (const line of raw.split(/\r?\n/)) {
                const value = line.trim();
                if (value && !value.startsWith("#")) {
                    patterns.push(value);
                }
            }
        } catch {
            // No ignore file is the normal case.
        }
    }

    extraIgnoreMatchers = patterns.map(toIgnoreMatcher).filter(Boolean);
    extraIgnoreGlobs = extraIgnoreMatchers.map((matcher) => `!${matcher.glob}`);
}

function isIgnoredRelativePath(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("../")) {
        return true;
    }

    if (IGNORED_EXACT_PATHS.has(normalized)) {
        return true;
    }

    if (IGNORED_ROOT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        return true;
    }

    const segments = normalized.split("/");
    if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
        return true;
    }

    for (const matcher of extraIgnoreMatchers) {
        if (matcher.regex.test(normalized) || normalized === matcher.bare) {
            return true;
        }
    }

    return false;
}

async function listFilesWithRipgrep(patterns) {
    if (process.env.NORMWIND_DISABLE_RIPGREP === "1") {
        const error = new Error("ripgrep is disabled in GitHub Action mode");
        error.code = "ENOENT";
        throw error;
    }
    const args = ["--files", "--hidden"];
    for (const glob of [...RG_IGNORE_GLOBS, ...extraIgnoreGlobs]) {
        args.push("-g", glob);
    }
    for (const pattern of patterns) {
        args.push("-g", pattern);
    }
    args.push(".");

    let stdout;
    try {
        ({ stdout } = await execFileAsync("rg", args, {
            cwd: process.cwd(),
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true,
        }));
    } catch (error) {
        // rg exit code 1 means "ran fine, nothing matched", which is a valid
        // empty result, NOT a reason to fall back to walking the whole tree
        // (which would silently scan everything a typo'd pattern never asked
        // for). Only spawn failures / real errors propagate to the fallback.
        if (error?.code === 1) {
            return [];
        }
        throw error;
    }

    return stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((filePath) => path.resolve(process.cwd(), filePath));
}


// visitedRealPaths guards against symlink loops: a directory symlink cycle
// (A/link -> B, B/link -> A) would otherwise recurse forever, since a plain
// entry.isDirectory() check follows the link. Each directory is realpath'd
// and deduped before recursing so a loop is walked at most once.
async function walkDirectory(directoryPath, results, visitedRealPaths = new Set()) {
    if (ACTION_WORKSPACE_ROOT) {
        await resolveActionSafePath(directoryPath, "scan directory");
    }
    let entries;
    try {
        entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name);
        const relativePath = normalizeRelativePath(fullPath);
        if (isIgnoredRelativePath(relativePath)) {
            continue;
        }

        if (entry.isSymbolicLink()) {
            const targetStats = await fs.stat(fullPath).catch(() => null);
            if (!targetStats || !targetStats.isDirectory()) {
                continue;
            }
            if (ACTION_WORKSPACE_ROOT) {
                throw new Error(`normwinds: Action mode refuses directory symlinks: ${relativePath}`);
            }
        } else if (!entry.isDirectory()) {
            if (entry.isFile() && hasAllowedExtension(relativePath)) {
                results.push(path.resolve(fullPath));
            }
            continue;
        }

        const realPath = await fs.realpath(fullPath).catch(() => null);
        if (!realPath) {
            continue;
        }
        if (!ACTION_WORKSPACE_ROOT) {
            if (visitedRealPaths.has(realPath)) {
                continue;
            }
            visitedRealPaths.add(realPath);
        }
        await walkDirectory(fullPath, results, visitedRealPaths);
    }
}

// Classifies one CLI target pattern into exactly one of the three buckets
// listTargetFiles collects: an explicit lintable file, a directory to walk,
// or a glob to resolve later. Mutates the passed-in collections so the
// caller's loop stays a flat, single-purpose iteration.
async function classifyTargetPattern(pattern, { explicitFiles, directoryTargets, globPatterns }) {
    validateActionPattern(pattern);
    if (hasGlobSyntax(pattern)) {
        // ripgrep treats a backslash as an escape character, not a path
        // separator, while the fallback walker's globPatternToRegExp
        // normalized it. `normwind "src\**\*.vue"` therefore matched a
        // different set depending on whether rg happened to be installed.
        // Normalize once, here, so both consumers see the same string.
        globPatterns.push(pattern.replace(/\\/g, "/"));
        return;
    }

    const resolved = path.resolve(process.cwd(), pattern);
    let stats = null;
    let targetPath = resolved;
    let linkStats;
    try {
        linkStats = await fs.lstat(resolved);
    } catch {
        globPatterns.push(pattern);
        return;
    }
    if (ACTION_WORKSPACE_ROOT && linkStats.isSymbolicLink()) {
        targetPath = await resolveActionSafePath(resolved, `target "${pattern}"`);
        stats = await fs.stat(targetPath);
        if (stats.isDirectory()) {
            throw new Error(`normwinds: Action mode refuses directory symlink target: ${pattern}`);
        }
    } else {
        stats = await fs.stat(resolved);
    }

    if (stats.isDirectory()) {
        directoryTargets.push(targetPath);
        return;
    }

    if (stats.isFile()) {
        const relativePath = normalizeRelativePath(targetPath);
        if (!isIgnoredRelativePath(relativePath) && hasAllowedExtension(relativePath)) {
            explicitFiles.add(path.resolve(targetPath));
        }
    }
}

// Adds every lintable file discovered from `filePaths` into `discoveredFiles`,
// applying the shared ignore/extension filter. Shared by every discovery
// path below (ripgrep glob results, the fallback walker, directory targets,
// the no-pattern default) so the filter can't drift between them.
function addLintableFiles(filePaths, discoveredFiles) {
    for (const filePath of filePaths) {
        const relativePath = normalizeRelativePath(filePath);
        if (!isIgnoredRelativePath(relativePath) && hasAllowedExtension(relativePath)) {
            discoveredFiles.add(path.resolve(filePath));
        }
    }
}

async function resolveGlobPatternTargets(globPatterns, discoveredFiles) {
    try {
        const files = await listFilesWithRipgrep(globPatterns);
        addLintableFiles(files, discoveredFiles);
    } catch {
        // ripgrep unavailable: walk the tree and apply the globs manually
        // so the fallback discovers the same set rg would have.
        const globRegexes = globPatterns.map(globPatternToRegExp);
        const walkedFiles = [];
        await walkDirectory(process.cwd(), walkedFiles);
        for (const filePath of walkedFiles) {
            const relativePath = normalizeRelativePath(filePath);
            if (globRegexes.some((regex) => regex.test(relativePath))) {
                discoveredFiles.add(path.resolve(filePath));
            }
        }
    }
}

// Positional targets are a union. A directory must still contribute all of
// its lintable files when a separate glob is supplied in the same command.
async function addDirectoryTargetFiles(directoryTargets, discoveredFiles) {
    for (const directoryPath of directoryTargets) {
        const files = [];
        await walkDirectory(directoryPath, files);
        for (const filePath of files) {
            discoveredFiles.add(path.resolve(filePath));
        }
    }
}

async function addDefaultDiscoveredFiles(discoveredFiles) {
    const files = await listFilesWithRipgrep(DEFAULT_PATTERNS).catch(async () => {
        const walkedFiles = [];
        await walkDirectory(process.cwd(), walkedFiles);
        return walkedFiles;
    });
    addLintableFiles(files, discoveredFiles);
}

async function listTargetFiles(patterns) {
    const explicitFiles = new Set();
    const directoryTargets = [];
    const globPatterns = [];

    const targetPatterns = patterns.length > 0 ? patterns : DEFAULT_PATTERNS;

    for (const pattern of targetPatterns) {
        await classifyTargetPattern(pattern, { explicitFiles, directoryTargets, globPatterns });
    }

    const discoveredFiles = new Set(explicitFiles);

    if (globPatterns.length > 0) {
        await resolveGlobPatternTargets(globPatterns, discoveredFiles);
    }

    if (directoryTargets.length > 0) {
        await addDirectoryTargetFiles(directoryTargets, discoveredFiles);
    }

    if (globPatterns.length === 0 && directoryTargets.length === 0 && explicitFiles.size === 0) {
        await addDefaultDiscoveredFiles(discoveredFiles);
    }

    const sortedFiles = [...discoveredFiles].sort((a, b) => a.localeCompare(b));
    if (!ACTION_WORKSPACE_ROOT) {
        return sortedFiles;
    }
    if (sortedFiles.length > ACTION_MAX_FILES) {
        throw new Error(`normwinds: Action scan exceeds the ${ACTION_MAX_FILES}-file limit`);
    }
    const validated = await runWithConcurrency(sortedFiles, FILE_SCAN_CONCURRENCY, async (filePath) => {
        const realPath = await resolveActionSafePath(filePath, "scan target");
        const stats = await fs.stat(realPath);
        if (!stats.isFile()) {
            throw new Error(`normwinds: Action scan target is not a regular file: ${realPath}`);
        }
        return { filePath: realPath, size: stats.size };
    });
    const totalBytes = validated.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes > ACTION_MAX_TOTAL_SOURCE_BYTES) {
        throw new Error(`normwinds: Action scan exceeds the ${ACTION_MAX_TOTAL_SOURCE_BYTES}-byte source limit`);
    }
    return [...new Set(validated.map((entry) => entry.filePath))].sort((a, b) => a.localeCompare(b));
}

export { isMarkupFile, listTargetFiles, loadIgnoreConfig };
