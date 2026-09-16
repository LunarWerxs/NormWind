# NormWind

> A CLI/GitHub Action that rewrites verbose Tailwind classes into canonical shorthand, using Tailwind's engine.

<!-- odin:about HAND-OWNED above the GENERATED marker. Edit freely; `odin codex about --ingest` carries it back into Odin's Codex. -->

## What it is

NormWind is a zero-config CLI and GitHub Action that audits Tailwind CSS class strings in Vue, Svelte, Astro, HTML, JavaScript, and TypeScript files and rewrites verbose utility combinations (px-4 py-4 -> p-4) and non-canonical arbitrary values (rounded-[24px] -> rounded-3xl) into their canonical short form, using Tailwind's own canonicalization engine so it never invents mappings. It targets Tailwind codebases that have drifted through many hands or AI-assisted edits, offering an audit-only mode for CI enforcement and a conservative autofix mode. It imposes no rules file, sort order, or config on the host project, and it is free and open source (MIT) with no paid tier.

## Things not to forget

_The intricacies worth remembering: the gotchas, the half-built parts, the decisions whose
reason lives nowhere else. Odin never overwrites this section._

- A shorthand merge is only applied after resolving the before/after class lists through Tailwind's own engine and comparing the emitted CSS declarations - if any other utility in the list would win differently after the merge, the merge is skipped rather than risking a silent visual regression. anchors: `lib/merge-safety.mjs:68`
- During --fix/--fixall, a locked, full-disk, or unparseable file is logged and skipped rather than aborting the whole batch, and the process exits with code 2 so CI can tell a partial run apart from a clean one. anchors: `lib/fix.mjs:379`
- .normwindignore is deliberately NOT honored when running as a GitHub Action, because the PR checkout it would read from is untrusted input - it only applies to local CLI runs. anchors: `lib/discovery.mjs:262`
- Paths resolved inside the GitHub Action (working-directory, theme-css, ignore globs, sarif-file) are confined to the checkout workspace via assertInsideActionWorkspace so a crafted PR cannot make the Action read or write outside it. anchors: `lib/workspace.mjs:66`
- Live canonicalization is hard-capped at 1000 unique cache misses per run (MAX_LIVE_CANONICALIZATION_CANDIDATES); a huge first-time scan on an uncached codebase will hit this and the runtime error tells the user to manually split the scan or warm the cache in batches - there is no flag to raise it. anchors: `lib/scan-config.mjs:16`
- The on-disk canonicalization cache is schema-versioned and keyed to the installed Tailwind version, so switching Tailwind versions invalidates it automatically instead of serving stale canonicalizations. anchors: `lib/canonical-cache.mjs:50`
- Both dependabot holds from 2026-09-10 are resolved as of 2026-09-14. @babel/parser is bumped to 8.0.5 and `engines.node` raised to `^22.18.0 || >=24.11.0` to match what it declares (that range was the whole hold; no code changes were needed). eslint-plugin-tailwindcss is bumped to 4.4.0; its `lib/config/groups.js` group table, which `lib/design-system.mjs` used to import at run time, has no v4 equivalent (v4 classifies shorthand families by querying a live Tailwind engine through an internal worker instead), so the last version's table (3.18.3) is vendored into `lib/vendor/tailwind-classname-groups.mjs` with its MIT notice in `THIRD-PARTY-NOTICES.md` - a port, not a bump. anchors: `package.json:41`, `lib/design-system.mjs:16`, `lib/vendor/tailwind-classname-groups.mjs:1`

<!-- odin:about GENERATED BEGIN - rewritten by `odin codex about --publish`; edit the Codex, not this -->

## What Odin knows about this project

Everything from here down is generated from this project's Codex dossier
(`codex/projects/normwinds.md` in the Odin clone) and is **rewritten on every publish** -
edit the dossier, not this block. Everything ABOVE the marker is yours.

### At a glance

- **Ships as:** CLI (npm/npx package) plus a bundled GitHub Action, published as @lunawerx/normwind on npm and as a GitHub Action in the same repo
- **Live at:** https://normwind.lunarwerx.com/
- **Written in:** JavaScript (38 files), Vue (33 files), TypeScript (30 files), Python (1 files)
- **Built with:** Tailwind
- **Package:** `@lunawerx/normwind` 3.8.1
- **Entry points:** `bin`, `scripts`
- **Tests:** 98 test file(s)
- **CI:** `ci.yml`, `release.yml`
- **Domain:** tailwind-css, css-utility-classes, linting, codemod
- **Remote:** git@github.com:LunarWerxs/NormWind.git

### Architecture

- `bin/normwind.mjs` - The CLI entrypoint: argv parsing, file discovery, the two-pass scan (shorthand + arbitrary-value canonicalization), report emission, exit codes.
- `action/index.mjs` - GitHub Action wrapper: shells out to the CLI with --json, converts the payload into inline PR annotations, a job summary, and optional SARIF, all confined to the Action's sandboxed workspace.
- `lib/discovery.mjs` - Which files a run scans: default include globs, generated-folder skip list, ripgrep-accelerated listing with a pure-JS glob fallback, .normwindignore.
- `lib/class-syntax.mjs` - Babel-AST and Vue-SFC-boundary analysis of where a class string may legally appear (class=, :class=, className={...}, cva/tv/clsx/cn calls, etc.).
- `lib/class-extraction.mjs` - Extracts concrete class-string tokens from the syntax positions class-syntax.mjs identifies.
- `lib/shorthand.mjs + lib/shorthand-families.mjs` - The shorthand merge engine and the utility-group table (derived from eslint-plugin-tailwindcss) describing what may be merged.
- `lib/merge-safety.mjs` - Proves a shorthand merge cannot change the rendered CSS by resolving before/after class lists through Tailwind's own engine and comparing declarations; skips the merge on any doubt.
- `lib/design-system.mjs + lib/canonical-cache.mjs` - Resolves and loads the Tailwind engine that judges a run, and memoizes canonicalization results to a disk cache validated against the Tailwind version.
- `lib/canonical-extract.mjs` - Generates the shipped canonical-replacement snapshot (docs/reference/canonical-replacements.{json,md}) used by --extract-canonical / --check-canonical.
- `lib/fix.mjs` - The --fix/--fixall path: rewrites class strings on disk via atomic temp-file-then-rename, preserves file modes, isolates per-file faults, supports --dry-run.
- `lib/sarif.mjs` - SARIF 2.1.0 report generation for GitHub code scanning and similar CI dashboards.
- `lib/theme-vars.mjs` - Opt-in named-theme-variable resolution (--suggest-named-theme-vars / --theme-css), including the direct and forwarder @theme patterns.
- `lib/workspace.mjs` - Package layout helpers and GitHub Action sandbox path confinement (assertInsideActionWorkspace).
- `lib/concurrency.mjs` - A fixed-size async worker pool used to parallelize per-file scanning.
- `scripts/` - Dev-facing build and test scripts: bundling the Action (build-action.mjs, ncc), unit/prepush/regression/comparison test runners, release.py.

### Features

19 recorded - 19 shipped, 0 partial, 0 planned. Each `path:line` is where the feature is DEFINED, checked by `odin codex check`.

**Shipped**

- **Shorthand utility-combination audit** - Detects verbose Tailwind utility combinations (px-4 py-4, w-6 h-6, content-center justify-center, ...) that a shorthand utility already expresses, using a group table derived from eslint-plugin-tailwindcss. - `bin/normwind.mjs:363`, `lib/shorthand-families.mjs:1`
- **Canonical arbitrary-value audit** - Flags arbitrary values (rounded-[24px], w-[100%], h-[1.5rem]) that Tailwind's own design system can express as a named utility, resolved through Tailwind's live canonicalizeCandidates engine rather than a hardcoded map. - `bin/normwind.mjs:238`, `lib/design-system.mjs:1`
- **Render-safe merge proof** - Before collapsing a utility group into shorthand, resolves the before/after class lists through Tailwind's engine and compares the emitted declarations, skipping the merge (rather than risking a silent visual regression) whenever another utility in the same class list would win differently after the merge. - `lib/merge-safety.mjs:68`, `lib/merge-safety.mjs:191`
- **Safe autofix (--fix)** - Rewrites markup-format files (.vue, .svelte, .astro, .html/.htm) in place with the audited findings, then re-audits; writes are atomic temp-file-then-rename and preserve Unix file modes. - `lib/fix.mjs:379`, `lib/fix.mjs:161`
- **Whole-codebase autofix (--fixall)** - Extends autofix to JS/MJS/CJS/TS/JSX/TSX/MTS/CTS source files in addition to markup, including composite equivalences (truncate, place-content-*, place-items-*, place-self-*) that were previously audit-only. - `lib/fix.mjs:379`, `bin/normwind.mjs:630`
- **Per-file fault isolation on fix runs** - A locked, full-disk, or unparseable file during --fix/--fixall is logged and skipped rather than aborting the batch; a fixed/skipped/failed summary prints to stderr and the process exits 2 so CI can distinguish a partial run from a clean one. - `lib/fix.mjs:379`
- **Dry-run preview** - --dry-run (with --fix or --fixall) prints which files would be rewritten, and combined with --json reports the same findings a real run would produce, without writing to disk. - `lib/fix.mjs:435`, `lib/cli-args.mjs:75`
- **Text, JSON, and SARIF reporters** - Findings can be printed as human-readable grouped text, a stable machine-readable JSON payload for custom tooling, or SARIF 2.1.0 for GitHub code scanning dashboards. - `bin/normwind.mjs:483`, `lib/sarif.mjs:7`
- **GitHub Action with inline PR annotations** - A first-party composite Action shells out to the bundled CLI, surfaces findings as inline PR annotations (capped by max-annotations) and a job summary, and can fail the workflow on findings. - `action/index.mjs:365`, `action.yml:1`
- **SARIF upload for code scanning** - The Action can write a SARIF report to a given path for pairing with github/codeql-action/upload-sarif so findings surface in GitHub's code scanning UI. - `action/index.mjs:137`, `action.yml:41`
- **Action workspace sandboxing** - Paths resolved inside the GitHub Action (working-directory, theme-css, ignore globs, sarif-file) are confined to the checkout workspace so a crafted PR input cannot escape it. - `lib/workspace.mjs:66`, `lib/workspace.mjs:72`
- **File discovery with generated-folder skip list** - Scans .vue/.svelte/.astro/.html/.htm/.js/.mjs/.cjs/.ts/.jsx/.tsx/.mts/.cts by default, skipping node_modules, dist, .next, .nuxt, cdk.out and similar folders at any depth, with ripgrep acceleration and a pure-JS glob fallback when ripgrep is unavailable. - `lib/discovery.mjs:360`, `lib/discovery.mjs:167`
- **Path and glob targeting with .normwindignore** - Accepts explicit path/glob targets on the CLI, repeatable --ignore flags, and a project-local .normwindignore file (gitignore-style); .normwindignore is deliberately not honored in Action mode since the checkout is untrusted PR input. - `lib/discovery.mjs:114`, `lib/discovery.mjs:262`
- **Class-bearing attribute and builder-call extraction** - Finds class strings only in real class-bearing positions: class/className/:class/v-bind:class attributes, object-property class forms passed to h/jsx/createElement-style calls, and string arguments to clsx/cx/cn/classnames/cva/tv/twMerge/twJoin (including locally-aliased imports), via Babel-AST parsing and Vue SFC boundary tracking. - `lib/class-syntax.mjs:299`, `lib/class-extraction.mjs:68`
- **Named theme-variable suggestions** - Opt-in (--suggest-named-theme-vars --theme-css <path>) rewrite of long-form Tailwind v4 @theme variable references (border-(--color-ink-400)) into the equivalent named utility (border-ink-400), supporting both direct and forwarder @theme patterns. - `lib/theme-vars.mjs:180`, `lib/theme-vars.mjs:72`
- **Canonical-replacement snapshot generation and drift check** - --extract-canonical (optionally --write-canonical-files) generates docs/reference/canonical-replacements.{json,md} from the live Tailwind engine; --check-canonical fails if those generated files are missing or stale; --cleanup-canonical-files removes them. - `lib/canonical-extract.mjs:153`
- **Persistent canonicalization cache** - Canonicalization results are memoized to an in-memory map and a schema-versioned on-disk cache keyed to the installed Tailwind version, so repeat runs and CI don't re-canonicalize unchanged class tokens. - `lib/canonical-cache.mjs:50`, `lib/canonical-cache.mjs:97`
- **Concurrent per-file scanning** - Scans files through a fixed-size async worker pool rather than serially, bounded to keep memory use predictable on large or untrusted diffs. - `lib/concurrency.mjs:8`
- **CLI flag surface and help** - Parses --reporter, --json, --ignore, --allow-empty, --fix/--fixall/--dry-run, --extract-canonical/--check-canonical/--cleanup-canonical-files, --suggest-named-theme-vars/--theme-css, -- passthrough, and -h/-v, with documented exit codes (0 clean, 1 findings, 2 usage/runtime error). - `lib/cli-args.mjs:75`, `lib/cli-args.mjs:151`

### Where to add a new one

- **a new shorthand utility group (e.g. a new Tailwind property pair that collapses to one utility)** - add the group to the vendored table in lib/vendor/tailwind-classname-groups.mjs (ported from eslint-plugin-tailwindcss 3.18.3, since v4 dropped the static table for a live-engine query and exports no equivalent); the merge-safety check in lib/merge-safety.mjs applies automatically to any group listed there. anchors: `lib/vendor/tailwind-classname-groups.mjs:1`, `lib/shorthand-families.mjs:1`
- **a new class-bearing syntax position to scan (a new attribute name or builder-call function)** - extend the position/shape recognizers in lib/class-syntax.mjs and the corresponding extraction in lib/class-extraction.mjs; both text-position based (markup) and Babel-AST based (JS/TS) paths need updating. anchors: `lib/class-syntax.mjs:299`, `lib/class-extraction.mjs:68`
- **a new CLI flag** - add parsing in lib/cli-args.mjs (parseArgs / handleLongFlagArg / handleShortFlagArg), wire the resulting option through bin/normwind.mjs's main(), and update printHelp. anchors: `lib/cli-args.mjs:75`, `lib/cli-args.mjs:33`, `bin/normwind.mjs:630`
- **a new report format** - add a formatter alongside printTextReport (bin/normwind.mjs) and buildSarifReport (lib/sarif.mjs), and route it from the --reporter flag in lib/cli-args.mjs. anchors: `bin/normwind.mjs:483`, `lib/sarif.mjs:7`
- **a new GitHub Action input/output** - add the input to action.yml, read it in action/index.mjs's runAction, and set the corresponding core.setOutput call; rebuild the bundled dist/index.mjs via `npm run build:action`. anchors: `action.yml:9`, `action/index.mjs:365`
- **a new file type or default-ignored folder** - extend the allowed-extension and skip-list logic in lib/discovery.mjs (hasAllowedExtension, isIgnoredRelativePath). anchors: `lib/discovery.mjs:83`, `lib/discovery.mjs:139`

### Gaps and wants

_Withheld: this repository is public, and the gap list is not published outside the private index._
_Read it with `python odin.py codex brief normwinds` in the Odin clone._

---

_Generated by `odin codex about --publish normwinds` on 2026-09-16 from a Codex dossier stamped 2026-09-15. Regenerate after the product moves; `odin codex about` reports drift._
<!-- odin:about GENERATED END sha=4c2f11445a88 -->
