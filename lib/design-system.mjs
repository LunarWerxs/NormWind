// Resolving and loading the Tailwind engine that judges this run.
//
// Canonicalization has to follow the SCANNED project's Tailwind semantics
// rather than NormWind's bundled fallback, so runtime resolution,
// design-system loading, and the theme-CSS inlining that augments it are one
// concern behind one set of promises.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import bundledTailwindGroupsModule from "eslint-plugin-tailwindcss/lib/config/groups.js";
import * as bundledTailwind from "tailwindcss";
import bundledTailwindPackage from "tailwindcss/package.json" with { type: "json" };
import { maskCssComments } from "./css.mjs";
import {
    ACTION_MAX_THEME_BYTES,
    ACTION_MAX_THEME_FILES,
    ACTION_WORKSPACE_ROOT,
    bundledRequire,
    resolveActionSafePath,
} from "./workspace.mjs";

let tailwindModuleCache = null;

function resolveTailwindRuntime() {
    // Canonicalization must follow the target project's Tailwind semantics.
    // NormWind bundles Tailwind as a zero-config fallback, but using that newer
    // engine against a project pinned to an older v4 release can suggest a
    // named utility whose theme value or availability changed between minors.
    // Resolve from cwd first so local installs, npx runs, and monorepo package
    // directories all use the Tailwind version that will actually build the
    // scanned source.
    if (process.env.NORMWIND_FORCE_BUNDLED_RUNTIME !== "1") {
        try {
            const projectRequire = createRequire(path.resolve(process.cwd(), "package.json"));
            const projectPkg = projectRequire("tailwindcss/package.json");
            const major = Number.parseInt(String(projectPkg?.version ?? "").split(".")[0], 10);
            if (major === 4) {
                return {
                    tailwind: projectRequire("tailwindcss"),
                    tailwindPkg: projectPkg,
                    tailwindRequire: projectRequire,
                    source: "project",
                };
            }
        } catch {
            // A project-local Tailwind install is optional. The bundled engine
            // preserves standalone/global operation and existing zero-config use.
        }
    }

    return {
        tailwind: bundledTailwind,
        tailwindPkg: bundledTailwindPackage,
        tailwindRequire: bundledRequire,
        tailwindIndexCssPath: process.env.NORMWIND_BUNDLED_TAILWIND_CSS || null,
        source: "bundled",
    };
}

function loadTailwind() {
    if (!tailwindModuleCache) {
        const runtime = resolveTailwindRuntime();
        tailwindModuleCache = {
            ...runtime,
            tailwindGroups: bundledTailwindGroupsModule.groups,
        };
    }
    return tailwindModuleCache;
}

let designSystemPromise = null;
async function loadTailwindDesignSystem() {
    if (!designSystemPromise) {
        designSystemPromise = (async () => {
            const { tailwind, tailwindRequire, tailwindIndexCssPath: configuredCssPath } = loadTailwind();
            const tailwindIndexCssPath = configuredCssPath || tailwindRequire.resolve("tailwindcss/index.css");
            const css = await fs.readFile(tailwindIndexCssPath, "utf8");
            const designSystem = await tailwind.__unstable__loadDesignSystem(css, {
                from: tailwindIndexCssPath,
            });
            return { designSystem, tailwindIndexCssPath };
        })();
    }
    return designSystemPromise;
}

// Match `@import "...";` (with or without trailing layer/media clauses).
// Captures the import specifier in group 2. Quotes can be " or '.
const CSS_IMPORT_REGEX = /@import\s+(["'])([^"']+)\1[^;]*;\s*/g;

// True when an @import target is a local file path (`./x`, `../x`, `/x`).
// Anything else (`tailwindcss`, `tailwindcss/preflight`, `@scope/pkg`, URLs)
// is treated as a package/runtime import and dropped. Tailwind's own CSS is
// already prepended by the caller, and other package imports cannot be
// resolved without a real bundler.
function isLocalCssImportSpecifier(spec) {
    return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

async function readThemeCssSource(filePath, budget) {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
        throw new Error(`normwinds: theme CSS path is not a regular file: ${filePath}`);
    }
    if (ACTION_WORKSPACE_ROOT) {
        budget.files += 1;
        budget.bytes += stats.size;
        if (budget.files > ACTION_MAX_THEME_FILES) {
            throw new Error(`normwinds: theme CSS import graph exceeds the Action limit of ${ACTION_MAX_THEME_FILES} files`);
        }
        if (budget.bytes > ACTION_MAX_THEME_BYTES) {
            throw new Error(`normwinds: theme CSS import graph exceeds the Action limit of ${ACTION_MAX_THEME_BYTES} bytes`);
        }
    }
    return fs.readFile(filePath, "utf8");
}


async function inlineLocalCssImports(sourceCss, sourcePath, visited, budget) {
    const sourceDir = path.dirname(sourcePath);
    const parts = [];
    let lastIndex = 0;
    // A commented-out `@import "./old-theme.css";` is not an import. Match
    // against a comment-masked copy (same length, so every index still lines
    // up) and slice the real text.
    const scannable = maskCssComments(sourceCss);
    // A fresh RegExp per recursion frame is required. Sharing the module-level
    // global instance lets a nested import reset its parent's lastIndex, which
    // can duplicate the CSS between imports and change last-declaration-wins
    // @theme semantics.
    const importRegex = new RegExp(CSS_IMPORT_REGEX.source, CSS_IMPORT_REGEX.flags);

    let match;
    while ((match = importRegex.exec(scannable)) !== null) {
        parts.push(sourceCss.slice(lastIndex, match.index));
        lastIndex = importRegex.lastIndex;

        const spec = match[2];
        if (!isLocalCssImportSpecifier(spec)) {
            // Drop package/url imports.
            continue;
        }

        const importedCandidate = path.resolve(sourceDir, spec);
        let importedAbs;
        try {
            importedAbs = ACTION_WORKSPACE_ROOT
                ? await resolveActionSafePath(importedCandidate, `CSS import "${spec}"`)
                : importedCandidate;
        } catch (error) {
            throw new Error(
                `normwinds: failed to resolve CSS import "${spec}" from ${sourcePath}: ${error.message}`,
            );
        }
        if (visited.has(importedAbs)) {
            // Already inlined upstream, so skip it to avoid cycles and
            // duplicate @theme blocks.
            continue;
        }
        visited.add(importedAbs);

        let importedSource;
        try {
            importedSource = await readThemeCssSource(importedAbs, budget);
        } catch (error) {
            throw new Error(
                `normwinds: failed to read CSS import "${spec}" from ${sourcePath}: ${error.message}`,
            );
        }

        const inlined = await inlineLocalCssImports(importedSource, importedAbs, visited, budget);
        parts.push(`/* normwinds inlined: ${importedAbs} */\n${inlined}\n`);
    }

    parts.push(sourceCss.slice(lastIndex));
    return parts.join("");
}

async function resolveThemeCssEntry(themeCssPath) {
    const candidate = path.resolve(process.cwd(), themeCssPath);
    const absPath = ACTION_WORKSPACE_ROOT
        ? await resolveActionSafePath(candidate, "theme CSS entry")
        : candidate;
    const budget = { files: 0, bytes: 0 };
    const entrySource = await readThemeCssSource(absPath, budget);
    const visited = new Set([absPath]);
    const resolvedCss = await inlineLocalCssImports(entrySource, absPath, visited, budget);
    return { absPath, resolvedCss, importedFiles: [...visited] };
}

// Separate cache for the user-augmented design system used by
// --suggest-named-theme-vars. Keyed by the absolute themeCssPath so multiple
// projects in the same Node process never cross-contaminate.
const augmentedDesignSystemPromises = new Map();
async function loadAugmentedDesignSystem(themeCssPath) {
    const absPath = path.resolve(process.cwd(), themeCssPath);
    let promise = augmentedDesignSystemPromises.get(absPath);
    if (!promise) {
        promise = (async () => {
            const { tailwind, tailwindRequire, tailwindIndexCssPath: configuredCssPath } = loadTailwind();
            const tailwindIndexCssPath = configuredCssPath || tailwindRequire.resolve("tailwindcss/index.css");
            const baseCss = await fs.readFile(tailwindIndexCssPath, "utf8");
            const { resolvedCss, importedFiles } = await resolveThemeCssEntry(themeCssPath);

            // Fail loud when the resolved CSS contains no @theme block. Without
            // a project @theme there are no forwarders to detect, so silently
            // returning zero suggestions would mask a misconfiguration. Strip
            // CSS comments first so a comment that mentions "@theme" doesn't
            // satisfy the check.
            const cssWithoutComments = resolvedCss.replace(/\/\*[\s\S]*?\*\//g, "");
            if (!/@theme\b/.test(cssWithoutComments)) {
                throw new Error(
                    `normwinds: --theme-css resolved no @theme block. Inspected ${importedFiles.length} file(s) starting at ${absPath}. Either local @import directives could not be resolved, or the wrong CSS entry was provided.`,
                );
            }

            const css = `${baseCss}\n/* normwinds: --theme-css */\n${resolvedCss}`;
            const themeCssHash = createHash("sha1").update(resolvedCss).digest("hex").slice(0, 12);

            const designSystem = await tailwind.__unstable__loadDesignSystem(css, {
                from: tailwindIndexCssPath,
            });
            return { designSystem, tailwindIndexCssPath, themeCssHash, importedFiles };
        })();
        augmentedDesignSystemPromises.set(absPath, promise);
    }
    return promise;
}

export { loadTailwind, loadTailwindDesignSystem, loadAugmentedDesignSystem };
