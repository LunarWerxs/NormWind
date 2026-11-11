// Which files a run scans.
//
// One engine everywhere: a bounded directory walker that applies NormWind's own
// ignore lists, .normwindignore and --ignore, plus the Action's hard caps on
// file count and total bytes. There used to be a second engine (ripgrep when it
// was on PATH) that also honoured .gitignore and read `[...]` as a character
// class, so the scanned set depended on the machine, and on Windows a bare
// `rg` resolved from the scanned folder first. .gitignore is deliberately not
// read: put generated sources in .normwindignore.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { globPatternToRegExp, hasGlobSyntax } from "./glob.mjs";
import { FILE_SCAN_CONCURRENCY, runWithConcurrency } from "./concurrency.mjs";
import { MARKUP_EXTENSIONS } from "./scan-config.mjs";
import {
    ACTION_MAX_FILES,
    ACTION_MAX_TOTAL_SOURCE_BYTES,
    ACTION_WORKSPACE_ROOT,
    resolveActionSafePath,
} from "./workspace.mjs";

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

function toIgnoreMatcher(pattern) {
    const trimmed = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!trimmed) {
        return null;
    }
    if (hasGlobSyntax(trimmed)) {
        return { regexes: [globPatternToRegExp(trimmed)] };
    }
    // A plain name follows the .gitignore convention: with no slash inside it
    // (`generated`, `generated/`) it matches a file or folder of that name at
    // ANY depth; with a slash (`src/generated`) it is anchored at the scan
    // root. Either way a folder means everything under it.
    const name = trimmed.replace(/\/+$/, "");
    const prefix = name.includes("/") ? "" : "**/";
    return {
        regexes: [
            globPatternToRegExp(`${prefix}${name}`),
            globPatternToRegExp(`${prefix}${name}/**`),
        ],
    };
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
        if (matcher.regexes.some((regex) => regex.test(normalized))) {
            return true;
        }
    }

    return false;
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

// Classifies one CLI target pattern into exactly one bucket: an explicit
// lintable file, a directory to walk, a glob to resolve later, or a refused
// file (one that exists but the ignore lists or the extension filter reject).
// Mutates the passed-in collections so the caller's loop stays flat.
//
// A path that exists on disk is taken literally BEFORE any glob test, so a
// Next/Nuxt/SvelteKit/Astro dynamic route such as `app/[slug]/page.tsx` is the
// file it names, not a pattern that never matches it.
async function classifyTargetPattern(pattern, { explicitFiles, directoryTargets, globPatterns, refusedFiles }) {
    validateActionPattern(pattern);

    const resolved = path.resolve(process.cwd(), pattern);
    let stats = null;
    let targetPath = resolved;
    let linkStats;
    try {
        linkStats = await fs.lstat(resolved);
    } catch {
        // Not a path on disk: a glob, or a typo that will match nothing and
        // be reported as such. Backslashes are path separators on input.
        globPatterns.push(pattern.replace(/\\/g, "/"));
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
        } else {
            refusedFiles.push(pattern);
        }
    }
}

// Walk the tree once (the walker already applies the ignore lists and the
// extension filter) and keep every file a glob matches.
async function resolveGlobPatternTargets(globPatterns, discoveredFiles) {
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

// With no positional targets the whole scan root is walked. With targets,
// only what they name is scanned: a file argument that is ignored or has an
// unsupported extension contributes nothing and comes back in `refusedFiles`,
// so `normwind --fix dist/app.vue` can never widen into a whole-project
// rewrite. Returns { files, refusedFiles }.
async function listTargetFiles(patterns) {
    const explicitFiles = new Set();
    const directoryTargets = [];
    const globPatterns = [];
    const refusedFiles = [];

    if (patterns.length === 0) {
        directoryTargets.push(process.cwd());
    }
    for (const pattern of patterns) {
        await classifyTargetPattern(pattern, { explicitFiles, directoryTargets, globPatterns, refusedFiles });
    }

    const discoveredFiles = new Set(explicitFiles);

    if (globPatterns.length > 0) {
        await resolveGlobPatternTargets(globPatterns, discoveredFiles);
    }

    if (directoryTargets.length > 0) {
        await addDirectoryTargetFiles(directoryTargets, discoveredFiles);
    }

    const sortedFiles = [...discoveredFiles].sort((a, b) => a.localeCompare(b));
    if (!ACTION_WORKSPACE_ROOT) {
        return { files: sortedFiles, refusedFiles };
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
    return {
        files: [...new Set(validated.map((entry) => entry.filePath))].sort((a, b) => a.localeCompare(b)),
        refusedFiles,
    };
}

export { isMarkupFile, listTargetFiles, loadIgnoreConfig };
