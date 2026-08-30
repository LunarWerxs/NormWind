// Generating the shipped canonical-replacement snapshot.
//
// Maintenance-only. --extract-canonical walks Tailwind's own utility surface to
// precompute every arbitrary-value token whose canonical form differs, so an
// ordinary consumer scan never has to load the design system at all.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ROOT_FONT_SIZE_PX } from "./constants.mjs";
import { expandValueVariants, extractFractionPercent, multiplyLength } from "./units.mjs";
import { loadTailwind, loadTailwindDesignSystem } from "./design-system.mjs";
import {
    CANONICAL_OUTPUT_JSON,
    CANONICAL_OUTPUT_MD,
    NORMWINDS_VERSION,
    PACKAGE_ROOT,
    toPortableModulePath,
} from "./workspace.mjs";

async function safeUnlink(filePath) {
    try {
        await fs.unlink(filePath);
    } catch {
        // Ignore missing-file and permission edge cases for cleanup mode.
    }
}

async function cleanupCanonicalArtifacts() {
    await safeUnlink(CANONICAL_OUTPUT_JSON);
    await safeUnlink(CANONICAL_OUTPUT_MD);
}








function collectCanonicalCandidateValues({ cssRule, parsedCandidate, themeValueMap }) {
    const values = new Set();

    if (parsedCandidate?.value?.fraction) {
        const percent = extractFractionPercent(parsedCandidate.value.fraction);
        if (percent) {
            values.add(percent);
        }
    }

    if (parsedCandidate?.value?.value?.includes("/")) {
        const percent = extractFractionPercent(parsedCandidate.value.value);
        if (percent) {
            values.add(percent);
        }
    }

    for (const match of cssRule.matchAll(/var\(--([a-z0-9-]+)\)/gi)) {
        const key = `--${match[1]}`;
        const resolved = themeValueMap.get(key);
        if (resolved) {
            values.add(String(resolved).trim());
        }
    }

    const spacingBase = themeValueMap.get("--spacing");
    if (spacingBase) {
        for (const match of cssRule.matchAll(/calc\(var\(--spacing\)\s*\*\s*(-?\d*\.?\d+)\)/gi)) {
            const factor = Number(match[1]);
            const resolved = multiplyLength(spacingBase, factor);
            if (resolved) {
                values.add(resolved);
            }
        }
    }

    for (const match of cssRule.matchAll(/\b(-?\d*\.?\d+(?:deg|rad|turn))\b/gi)) {
        values.add(match[1]);
    }

    for (const match of cssRule.matchAll(/\b(-?\d*\.?\d+%)\b/g)) {
        values.add(match[1]);
    }

    return [...values].filter(Boolean);
}

function addCanonicalReplacement(replacements, inputClass, canonicalClass, sourceClass) {
    const key = `${inputClass}=>${canonicalClass}`;
    if (!replacements.has(key)) {
        replacements.set(key, {
            inputClass,
            canonicalClass,
            sourceClass,
        });
    }
}

// Compute the arbitrary-value -> canonical replacements for one canonical
// class, adding hits into replacementMap. Split out of
// extractCanonicalReplacements's classList loop, which nested this same
// logic two loops deep with half a dozen early continues.
function collectReplacementsForCanonicalClass(canonicalClass, designSystem, themeValueMap, replacementMap) {
    if (canonicalClass.includes("[") || canonicalClass.includes("]") || canonicalClass.includes(":")) {
        return;
    }

    const parsedCandidates = designSystem.parseCandidate(canonicalClass);
    if (!Array.isArray(parsedCandidates) || parsedCandidates.length !== 1) {
        return;
    }

    const parsed = parsedCandidates[0];
    if (parsed?.kind !== "functional" || parsed?.value?.kind !== "named") {
        return;
    }

    const cssRule = designSystem.candidatesToCss([canonicalClass])?.[0] ?? "";
    if (!cssRule) {
        return;
    }

    const candidateValues = collectCanonicalCandidateValues({
        cssRule,
        parsedCandidate: parsed,
        themeValueMap,
    });

    if (candidateValues.length === 0) {
        return;
    }

    for (const candidateValue of candidateValues) {
        for (const valueVariant of expandValueVariants(candidateValue)) {
            // Tailwind source classes encode spaces inside arbitrary values
            // as underscores. Literal-space keys can never be looked up
            // after class strings are tokenized on whitespace.
            const encodedValue = valueVariant.replace(/\s+/g, "_");
            const inputClass = `${parsed.root}-[${encodedValue}]`;
            const canonicalized = designSystem.canonicalizeCandidates([inputClass], {
                rem: ROOT_FONT_SIZE_PX,
            })?.[0] ?? inputClass;

            if (canonicalized === inputClass) {
                continue;
            }

            addCanonicalReplacement(replacementMap, inputClass, canonicalized, canonicalClass);
        }
    }
}

async function extractCanonicalReplacements({ writeFiles, checkOnly = false }) {
    const { designSystem, tailwindIndexCssPath } = await loadTailwindDesignSystem();
    const { tailwindPkg } = loadTailwind();
    if (typeof designSystem.canonicalizeCandidates !== "function") {
        throw new Error(
            `normwinds: Tailwind ${tailwindPkg.version} does not expose the canonicalization API required by --extract-canonical/--check-canonical`,
        );
    }

    const classList = designSystem.getClassList().map(([className]) => className);
    const themeValueMap = new Map();
    for (const [key, entry] of designSystem.theme.values.entries()) {
        if (entry && typeof entry.value === "string") {
            themeValueMap.set(key, entry.value);
        }
    }

    const replacementMap = new Map();

    for (const canonicalClass of classList) {
        collectReplacementsForCanonicalClass(canonicalClass, designSystem, themeValueMap, replacementMap);
    }

    const replacements = [...replacementMap.values()].sort(
        (a, b) =>
            a.canonicalClass.localeCompare(b.canonicalClass) ||
            a.inputClass.localeCompare(b.inputClass),
    );

    const payload = {
        source: {
            engine: "tailwindcss.designSystem.canonicalizeCandidates",
            tailwindVersion: tailwindPkg.version,
            // Stored relative to the package root so the committed artifact is
            // byte-identical across machines and checkout locations; an
            // absolute path here would fail --check-canonical on every other
            // machine. toolVersion is intentionally omitted for the same
            // reason: the snapshot's identity is the Tailwind version plus the
            // replacement set, not the tool release that generated it.
            tailwindIndexCssPath: toPortableModulePath(PACKAGE_ROOT, tailwindIndexCssPath),
            rootFontSizePx: ROOT_FONT_SIZE_PX,
        },
        totals: {
            classListCount: classList.length,
            replacementCount: replacements.length,
        },
        replacements,
    };

    const topExamples = replacements.slice(0, 25);
    const roundedExample = replacements.find(
        (entry) =>
            entry.inputClass === "rounded-[24px]" && entry.canonicalClass === "rounded-3xl",
    );

    const markdownLines = [
        "# Tailwind Canonical Replacements (Generated)",
        "",
        "This file is generated from Tailwind's canonicalization engine.",
        "",
        "- Source engine: `tailwindcss.designSystem.canonicalizeCandidates`",
        `- Tailwind version: \`${tailwindPkg.version}\``,
        `- Class list scanned: \`${classList.length}\``,
        `- Canonical replacements extracted: \`${replacements.length}\``,
        "",
        "## Drift Prevention",
        "",
        "Regenerate this catalog whenever Tailwind is upgraded:",
        "",
        "```bash",
        "npm run canonical:extract",
        "```",
        "",
        "Recommended CI gate:",
        "",
        "```bash",
        "npm run canonical:check",
        "```",
        "",
        "## Verified Example",
        "",
    ];

    if (roundedExample) {
        markdownLines.push(
            `- \`${roundedExample.inputClass}\` -> \`${roundedExample.canonicalClass}\``,
            "",
        );
    } else {
        markdownLines.push("- `rounded-[24px]` mapping was not found in this extraction run.", "");
    }

    markdownLines.push("## Sample Replacements", "", "| Input | Canonical |", "| --- | --- |");
    for (const example of topExamples) {
        markdownLines.push(`| \`${example.inputClass}\` | \`${example.canonicalClass}\` |`);
    }

    markdownLines.push(
        "",
        "For the full machine-readable list, see:",
        "",
        "- `docs/reference/canonical-replacements.json`",
    );

    const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
    const markdownText = `${markdownLines.join("\n")}\n`;

    if (checkOnly) {
        const [existingJson, existingMarkdown] = await Promise.all([
            fs.readFile(CANONICAL_OUTPUT_JSON, "utf8").catch(() => null),
            fs.readFile(CANONICAL_OUTPUT_MD, "utf8").catch(() => null),
        ]);

        // Tolerate CRLF in the on-disk copies: git's autocrlf hands the
        // committed artifacts to us with CRLF on Windows checkouts, and the
        // drift check must not fail over line endings the tool didn't write.
        const normalizeEol = (text) => (text === null ? null : text.replace(/\r\n/g, "\n"));

        if (normalizeEol(existingJson) !== jsonText || normalizeEol(existingMarkdown) !== markdownText) {
            console.error("normwinds: canonical replacement artifacts are out of date.");
            console.error("Run `normwind --extract-canonical --write-canonical-files` and commit the generated files.");
            process.exitCode = 1;
            return;
        }

        console.log(`normwinds v${NORMWINDS_VERSION}: canonical replacement artifacts are up to date.`);
        return;
    }

    console.log(`normwinds v${NORMWINDS_VERSION}: extracted ${replacements.length} canonical replacement(s).`);

    if (writeFiles) {
        await fs.mkdir(path.dirname(CANONICAL_OUTPUT_JSON), { recursive: true });
        await fs.writeFile(CANONICAL_OUTPUT_JSON, jsonText, "utf8");
        await fs.writeFile(CANONICAL_OUTPUT_MD, markdownText, "utf8");
        console.log(`  wrote ${path.relative(process.cwd(), CANONICAL_OUTPUT_JSON)}`);
        console.log(`  wrote ${path.relative(process.cwd(), CANONICAL_OUTPUT_MD)}`);
        return;
    }

    console.log("  files were not written (use --write-canonical-files to persist artifacts)");
}

export { cleanupCanonicalArtifacts, extractCanonicalReplacements };
