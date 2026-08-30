// Package layout and GitHub Action sandbox.
//
// Two things that are really one: every path NormWind resolves is either
// relative to the installed package (the bundled canonical snapshot, the
// version) or has to be proven to sit inside the Action's checked-out
// workspace before it is read. Keeping both here means there is exactly one
// definition of "inside the workspace" for every reader to share.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const bundledRequire = createRequire(import.meta.url);

// Single source of truth: npm always includes package.json in the published
// tarball, so the version is read from it rather than duplicated here.
export const NORMWINDS_VERSION = bundledRequire("../package.json").version;

export const CANONICAL_OUTPUT_JSON = path.resolve(
    process.cwd(),
    "docs/reference/canonical-replacements.json",
);
export const CANONICAL_OUTPUT_MD = path.resolve(
    process.cwd(),
    "docs/reference/canonical-replacements.md",
);
export const BUNDLED_CANONICAL_JSON = path.resolve(
    PACKAGE_ROOT,
    "docs/reference/canonical-replacements.json",
);

export const ACTION_WORKSPACE_ROOT = process.env.NORMWIND_ACTION_WORKSPACE
    ? path.resolve(process.env.NORMWIND_ACTION_WORKSPACE)
    : null;
export const ACTION_MAX_FILES = 20_000;
export const ACTION_MAX_TOTAL_SOURCE_BYTES = 256 * 1024 * 1024;
export const ACTION_MAX_THEME_FILES = 100;
export const ACTION_MAX_THEME_BYTES = 5 * 1024 * 1024;

function isInsidePath(parent, child) {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Portable form of a resolved dependency path, for anything that gets written into a
// committed artifact.
//
// `require.resolve` returns the REAL path, and a package does not have to live inside the
// package root: under a shared/global package store (bun's isolated linker + globalStore,
// pnpm, yarn) `node_modules/<pkg>` is a symlink and the real file sits outside the checkout
// entirely. `path.relative(PACKAGE_ROOT, ...)` then produces machine-specific `../../..`
// noise, and --check-canonical fails on every machine whose store is somewhere else.
//
// Fall back to the node_modules-relative form, which is stable across every layout.
function toPortableModulePath(root, absolutePath) {
    const relative = path.relative(root, absolutePath).replace(/\\/g, "/");
    if (!relative.startsWith("../")) return relative;
    const posix = absolutePath.replace(/\\/g, "/");
    const marker = posix.lastIndexOf("/node_modules/");
    return marker === -1 ? relative : posix.slice(marker + 1);
}

function assertInsideActionWorkspace(filePath, label) {
    if (ACTION_WORKSPACE_ROOT && !isInsidePath(ACTION_WORKSPACE_ROOT, filePath)) {
        throw new Error(`normwinds: ${label} escapes the checked-out workspace: ${filePath}`);
    }
}

async function resolveActionSafePath(filePath, label) {
    const realPath = await fs.realpath(filePath);
    assertInsideActionWorkspace(realPath, label);
    return realPath;
}

export { isInsidePath, toPortableModulePath, assertInsideActionWorkspace, resolveActionSafePath };
