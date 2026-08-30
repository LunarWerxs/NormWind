// The command line: which flags exist, how argv parses, and --help.

import path from "node:path";
import { NORMWINDS_VERSION } from "./workspace.mjs";

const KNOWN_FLAGS = new Set([
    "--allow-empty",
    "--check-canonical",
    "--cleanup-canonical-files",
    "--dry-run",
    "--extract-canonical",
    "--fix",
    "--fixall",
    "--help",
    "-h",
    "--ignore",
    "--json",
    "--reporter",
    "--suggest-named-theme-vars",
    "--theme-css",
    "--version",
    "-v",
    "--write-canonical-files",
]);
const VALUE_FLAGS = new Set(["--ignore", "--reporter", "--theme-css"]);
// Flags that accumulate instead of last-one-wins.
const REPEATABLE_VALUE_FLAGS = new Set(["--ignore"]);
const REPORTERS = new Set(["text", "json", "sarif"]);

// Handles one `--`-prefixed CLI token: `--key=value`, `--key value`, or a
// bare flag. Returns true when it consumed `nextArg` as a value, so the
// caller's loop index can skip past it.
function handleLongFlagArg(arg, nextArg, { flags, unknownFlags, missingValueFlags, recordValue }) {
    // Support `--key=value` and `--key value` for value-bearing flags.
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
        const key = arg.slice(0, eqIdx);
        if (!KNOWN_FLAGS.has(key)) {
            unknownFlags.push(key);
            return false;
        }
        recordValue(key, arg.slice(eqIdx + 1));
        return false;
    }

    if (!KNOWN_FLAGS.has(arg)) {
        unknownFlags.push(arg);
        return false;
    }

    if (VALUE_FLAGS.has(arg)) {
        if (nextArg !== undefined && !nextArg.startsWith("-")) {
            recordValue(arg, nextArg);
            return true;
        }
        missingValueFlags.push(arg);
        return false;
    }

    flags.add(arg);
    return false;
}

// Single-dash aliases (-h, -v). Anything else starting with "-" is a
// typo'd flag, not a file pattern, so surface it instead of silently
// scanning nothing.
function handleShortFlagArg(arg, { flags, unknownFlags }) {
    if (KNOWN_FLAGS.has(arg)) {
        flags.add(arg);
    } else {
        unknownFlags.push(arg);
    }
}

function parseArgs(argv) {
    const flags = new Set();
    const patterns = [];
    const valueFlags = Object.create(null);
    const repeatedValues = Object.create(null);
    const unknownFlags = [];
    const missingValueFlags = [];
    let sawSeparator = false;

    const recordValue = (key, value) => {
        valueFlags[key] = value;
        if (REPEATABLE_VALUE_FLAGS.has(key)) {
            (repeatedValues[key] ??= []).push(value);
        }
        flags.add(key);
    };
    const flagCtx = { flags, unknownFlags, missingValueFlags, recordValue };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        // Everything after a bare `--` is a positional target, even if it
        // starts with a dash. Without this a file literally named `-weird.vue`
        // was unreachable.
        if (!sawSeparator && arg === "--") {
            sawSeparator = true;
            continue;
        }
        if (sawSeparator) {
            patterns.push(arg);
            continue;
        }

        if (arg.startsWith("--")) {
            if (handleLongFlagArg(arg, argv[i + 1], flagCtx)) {
                i += 1;
            }
            continue;
        }

        if (arg.startsWith("-") && arg.length > 1) {
            handleShortFlagArg(arg, flagCtx);
            continue;
        }

        patterns.push(arg);
    }

    // --json is the long-standing alias for --reporter json and stays
    // supported; an explicit --reporter wins when both are given.
    const requestedReporter = valueFlags["--reporter"] ?? (flags.has("--json") ? "json" : "text");
    const reporter = REPORTERS.has(requestedReporter) ? requestedReporter : null;

    return {
        allowEmpty: flags.has("--allow-empty"),
        checkCanonical: flags.has("--check-canonical"),
        cleanupCanonicalFiles: flags.has("--cleanup-canonical-files"),
        dryRun: flags.has("--dry-run"),
        extractCanonical: flags.has("--extract-canonical"),
        fix: flags.has("--fix") || flags.has("--fixall"),
        fixAll: flags.has("--fixall"),
        help: flags.has("--help") || flags.has("-h"),
        ignorePatterns: repeatedValues["--ignore"] ?? [],
        json: reporter === "json",
        reporter,
        invalidReporter: reporter === null ? requestedReporter : null,
        suggestNamedThemeVars: flags.has("--suggest-named-theme-vars"),
        themeCssPath: valueFlags["--theme-css"] || null,
        version: flags.has("--version") || flags.has("-v"),
        writeCanonicalFiles: flags.has("--write-canonical-files"),
        patterns,
        unknownFlags,
        missingValueFlags,
    };
}

function printHelp() {
    console.log(`normwinds v${NORMWINDS_VERSION} - Tailwind shorthand audit + safe autofix

Usage:
  normwinds [patterns...] [flags]

Patterns:
  Positional arguments may be file paths, directories, or globs
  (e.g. \`normwinds src\`, \`normwinds "src/**/*.vue"\`, \`normwinds App.tsx\`).
  With no patterns, the default scan is
  **/*.{vue,svelte,astro,html,js,mjs,cjs,ts,jsx,tsx,mts,cts} from the current
  directory, skipping .git, node_modules, dist, coverage, build output and
  other generated folders. Use \`--\` to end flag parsing when a target starts
  with a dash.

Exit codes:
  0 no findings   1 findings reported   2 usage or runtime error

Flags:
  --fix                       Auto-fix supported transforms in .vue files
  --fixall                    Auto-fix in all matched files (.vue/.js/.mjs/.ts/.jsx/.tsx)
  --dry-run                   With --fix/--fixall, show which files WOULD be
                              rewritten without writing anything to disk.
  --json                      Emit findings as JSON (alias for --reporter json)
  --reporter <text|json|sarif>
                              Output format. \`sarif\` emits SARIF 2.1.0 for
                              GitHub code scanning and similar CI dashboards.
  --ignore <glob>             Skip paths matching this glob. Repeatable. A
                              project-local .normwindignore file (one glob per
                              line, # for comments) is also read automatically.
  --allow-empty               Exit 0 instead of 2 when the given pattern(s)
                              match no lintable files.
  --suggest-named-theme-vars  (opt-in, audit only) Emit findings that suggest
                              replacing \`utility-(--var)\` and
                              \`utility-[var(--var)]\` with the named-utility
                              form (e.g. \`utility-name\`) when the project's
                              @theme registers \`--var\` directly or forwards to
                              it. Requires --theme-css. During --fix/--fixall,
                              the same replacements are applied automatically
                              whenever --theme-css is set; safety is gated by
                              per-token CSS equivalence.
  --theme-css <path>          Path to the project's Tailwind entry CSS that
                              contains the @theme block. Used to detect
                              registered theme variables and forwarders.
  --extract-canonical         (maintenance) Rebuild the canonical replacement
                              reference data.
  --check-canonical           (CI) Exit non-zero if the bundled canonical
                              replacement artifacts are stale relative to the
                              installed Tailwind version.
  --write-canonical-files     Persist the extracted reference data to
                              docs/reference/canonical-replacements.{json,md}
  --cleanup-canonical-files   Remove the persisted reference data
  -v, --version               Print the normwinds version and exit
  -h, --help                  Show this help and exit
`);
}

export { parseArgs, printHelp };
