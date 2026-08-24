<div align="center">

<a href="https://github.com/LunarWerxs/NormWind">
  <img src="https://raw.githubusercontent.com/LunarWerxs/NormWind/main/assets/normwind-share-card.png" alt="NormWind: Normalize Tailwinds" width="880">
</a>

<br/>
<br/>

[![npm version](https://img.shields.io/npm/v/@lunawerx/normwind?style=flat-square&logo=npm&logoColor=white&label=npm&color=05b0dc&labelColor=0a0e17)](https://www.npmjs.com/package/@lunawerx/normwind)
[![npm downloads](https://img.shields.io/npm/dm/@lunawerx/normwind?style=flat-square&label=downloads&color=0588bd&labelColor=0a0e17)](https://www.npmjs.com/package/@lunawerx/normwind)
[![node](https://img.shields.io/node/v/@lunawerx/normwind?style=flat-square&label=node&color=04609f&labelColor=0a0e17)](https://nodejs.org)
[![Tailwind CSS v4](https://img.shields.io/badge/Tailwind_CSS-v4-05b0dc?style=flat-square&logo=tailwindcss&logoColor=white&labelColor=0a0e17)](https://tailwindcss.com)
[![license MIT](https://img.shields.io/badge/license-MIT-05b0dc?style=flat-square&labelColor=0a0e17)](https://opensource.org/licenses/MIT)

<strong>Normalize Tailwinds.</strong><br/>
A zero-config CLI and GitHub Action that finds bloated Tailwind utility classes and rewrites them into their short, canonical form.

</div>

---

NormWind is a zero-config CLI and GitHub Action that audits Tailwind CSS class strings in Vue, Svelte, Astro, HTML, JavaScript, and TypeScript files, then rewrites verbose utility combinations and non-canonical arbitrary values into their shorter canonical form using Tailwind's own canonicalization engine, without imposing a rules file or sort order on the project.

Tailwind codebases drift. Over time (especially with a dozen hands and a few AI assistants on the keyboard) class strings pile up combinations that are perfectly valid but noisier than they need to be. `px-4 py-4` where `p-4` would do. `rounded-[24px]` where `rounded-3xl` already exists. `w-6 h-6` instead of `size-6`.

**NormWind** hunts those down. Point it at your project and it will either **tell you** what could be tightened, or **fix it for you**: safely, deterministically, and without forcing a formatter, a sort order, or any config on your repo.

```bash
npx @lunawerx/normwind           # audit
npx @lunawerx/normwind --fix      # audit, then safely rewrite
```

## ✨ At a glance

NormWind collapses two kinds of noise: **verbose utility combinations** and **non-canonical arbitrary values**.

| You wrote…                        | NormWind gives you |
| --------------------------------- | ------------------ |
| `px-4 py-4`                       | `p-4`              |
| `pl-2 pr-2`                       | `px-2`             |
| `mt-3 mb-3`                       | `my-3`             |
| `w-6 h-6`                         | `size-6`           |
| `content-center justify-center`   | `place-content-center` |
| `rounded-[24px]`                  | `rounded-3xl`      |
| `w-[100%]`                        | `w-full`           |
| `h-[1.5rem]`                      | `h-6`              |

Every rewrite is backed by Tailwind's **own** engine (more on that [below](#-why-you-can-trust-the-rewrites)); NormWind never guesses.

## 🤔 Why you'd want it

Reach for NormWind when you want:

- 🧵 **Shorter class strings** that stay readable
- 🎯 **Consistent shorthand** across a whole team
- 🚫 **Fewer arbitrary values** when a named Tailwind token already exists
- 🛡️ **CI enforcement** so utility bloat never lands on `main` again
- 🩹 **Safe autofixes**: markup-first by default (Vue, Svelte, Astro, HTML), broader when you ask for it
- 🌱 **Zero config**: no rules file, no plugins to register, no opinions imposed

## 📦 Install

```bash
npm i -D @lunawerx/normwind
```

…or don't install it at all:

```bash
npx @lunawerx/normwind
```

Both command names are exposed, so pick whichever your fingers prefer:

```bash
normwind
normwinds
```

## 🚀 Quick start

```bash
# Audit the current project (exits 1 if there's anything to clean up)
npx @lunawerx/normwind

# Apply safe, markup-first fixes, then re-audit
npx @lunawerx/normwind --fix

# Go wide: fix across every supported file type
npx @lunawerx/normwind --fixall

# Preview a fix run without writing anything to disk
npx @lunawerx/normwind --fixall --dry-run

# Machine-readable output for CI and custom tooling
npx @lunawerx/normwind --json

# Scope it to a folder or a glob
npx @lunawerx/normwind src
npx @lunawerx/normwind "apps/web/**/*.{tsx,ts}"
```

## 🧠 What NormWind checks

### Shorthand utility combinations

NormWind detects class groups that Tailwind can express with a shorter shorthand:

| Verbose                               | Canonical shorthand    |
| ------------------------------------- | ---------------------- |
| `px-4 py-4`                           | `p-4`                  |
| `pl-2 pr-2`                           | `px-2`                 |
| `mt-3 mb-3`                           | `my-3`                 |
| `left-0 right-0`                      | `inset-x-0`            |
| `top-0 bottom-0`                      | `inset-y-0`            |
| `gap-x-4 gap-y-4`                     | `gap-4`                |
| `overflow-x-hidden overflow-y-hidden` | `overflow-hidden`      |
| `w-6 h-6`                             | `size-6`               |
| `content-center justify-center`       | `place-content-center` |
| `items-start justify-items-start`     | `place-items-start`    |
| `self-end justify-self-end`           | `place-self-end`       |

### Canonical arbitrary values

It also catches arbitrary values that Tailwind's own design system can express as a named utility:

| Arbitrary        | Canonical     |
| ---------------- | ------------- |
| `rounded-[24px]` | `rounded-3xl` |
| `w-[100%]`       | `w-full`      |
| `h-[1.5rem]`     | `h-6`         |
| `p-[1rem]`       | `p-4`         |
| `m-[8px]`        | `m-2`         |

### 🔒 Why you can trust the rewrites

NormWind doesn't invent mappings:

- **Shorthand groups** come straight from [`eslint-plugin-tailwindcss`](https://github.com/francoismassart/eslint-plugin-tailwindcss)'s Tailwind utility-group definitions.
- **Canonical values** come from Tailwind's own `designSystem.canonicalizeCandidates` engine.
- **A merge is only applied when it cannot change the rendered CSS.** Tailwind emits utilities in its own order (broad before narrow, and same-utility candidates sorted by value), not in authoring order. Collapsing `ml-2 mr-2` into `mx-2` when the same class list already has `mx-8` would hand the win to `mx-8` and silently change the margin. So whenever another utility in the same group targets the same property at a different value, NormWind resolves the before and after class lists through Tailwind's own engine and compares the resulting declarations; if they differ at all, the merge is skipped. Skipping costs a suggestion; applying would cost a silent visual regression.

This is deliberately conservative: an unusual class list can keep a merge NormWind could not prove safe, and that's the correct outcome.

## 🎛️ CLI reference

| Command                                                  | What it does |
| -------------------------------------------------------- | ------------ |
| `normwind`                                               | Audit supported files. Exits `1` when findings exist. |
| `normwind --reporter <text\|json\|sarif>`                | Choose the output format. `sarif` emits SARIF 2.1.0 for GitHub code scanning and similar CI dashboards. |
| `normwind --json`                                        | Print machine-readable audit output (alias for `--reporter json`). |
| `normwind --ignore <glob>`                               | Skip paths matching a glob. Repeatable. |
| `normwind --allow-empty`                                 | Exit `0` instead of `2` when the given pattern(s) match no lintable files. |
| `normwind --fix`                                         | Apply safe fixes across every markup format (Vue, Svelte, Astro, HTML), then re-run the audit. |
| `normwind --fixall`                                      | Apply broader fixes across every supported source type, including JS, MJS, CJS, TS, JSX, TSX, MTS, and CTS, then re-run the audit. |
| `normwind --fix --dry-run` / `normwind --fixall --dry-run` | Show which files *would* be rewritten without writing anything to disk. |
| `normwind --extract-canonical`                           | Extract canonical replacements in memory and print a summary. |
| `normwind --extract-canonical --write-canonical-files`   | Write `docs/reference/canonical-replacements.{json,md}`. |
| `normwind --check-canonical`                             | Fail if the generated canonical files are missing or stale. |
| `normwind --cleanup-canonical-files`                     | Remove generated canonical files from `docs/reference`. |
| `normwind --suggest-named-theme-vars --theme-css <path>` | *(opt-in)* Suggest replacing `utility-(--md-sys-color-x)` with your project's named theme class. Off by default. |
| `normwind -- <path>`                                     | End flag parsing, so a target that starts with a dash is treated as a pattern, not a flag. |
| `normwind -h, --help`                                    | Print usage and exit `0`. |
| `normwind -v, --version`                                 | Print the installed normwind version and exit `0`. |

## 🧾 Output

Text output groups findings by file, readable at a glance:

```text
normwinds v3.5.0: 2 finding(s) across 1 linted file(s).

src/components/Card.vue
    42:14 Classnames 'px-4, py-4' could be replaced by the 'p-4' shorthand!
    67:10 The class 'rounded-[24px]' can be written as 'rounded-3xl'
```

JSON output is stable and CI-friendly:

```json
{
  "version": "3.5.0",
  "ruleId": "tailwindcss/enforces-shorthand",
  "lintedFiles": 1,
  "findingCount": 1,
  "findings": [
    {
      "filePath": "src/components/Card.vue",
      "line": 42,
      "column": 14,
      "message": "Classnames 'px-4, py-4' could be replaced by the 'p-4' shorthand!"
    }
  ]
}
```

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | No findings, or a requested maintenance command completed successfully. |
| `1`  | Audit findings exist, or canonical drift was detected. |
| `2`  | Usage or runtime error (unknown flag, invalid `--reporter` value, missing `--theme-css` value, unreadable `--theme-css` path, etc.); a pattern matched no lintable files (pass `--allow-empty` for `0` instead); `--fix`/`--fixall`/`--dry-run` was combined with `--check-canonical`, `--extract-canonical`, or `--cleanup-canonical-files`; `--dry-run` was passed without `--fix`/`--fixall`; **or** `--fix`/`--fixall` finished with one or more files skipped/failed (see the fix summary printed to stderr). |

## 🔧 Fix modes

### `--fix`: the safe default

`--fix` is intentionally conservative. It covers every markup format (`.vue`, `.svelte`, `.astro`, `.html`/`.htm`) and is the best default for application projects that just want tidy, low-risk cleanup.

### `--fixall`: the whole codebase

`--fixall` applies the broader class-string rewrite pass across **all** supported source types, including `.js`/`.mjs`/`.cjs`/`.ts`/`.jsx`/`.tsx`/`.mts`/`.cts`. Use it for explicit cleanup branches, codemods, or repos with solid review coverage.

Composite equivalences (`truncate`, `place-content-*`, `place-items-*`, `place-self-*`) are now applied by both `--fix` and `--fixall`, not just reported. Previously they were audit-only findings a fix run could never resolve, so a fix-then-audit CI loop could never reach exit `0`.

### Per-file fault isolation

Each file's read, transform, and write are isolated: a locked file (`EBUSY`/`EPERM`, common on Windows when an editor or antivirus has it open), a full disk (`ENOSPC`), or an edge-case parser exception on one file is logged and skipped. It never aborts the rest of the batch. At the end of a run with any skips or failures, a summary is printed to stderr (`fix summary: N fixed, N skipped, N failed`) with a line per affected file, and the process exits `2` so CI can distinguish a partial run from a clean one.

### `--dry-run`: preview without writing

Add `--dry-run` to either `--fix` or `--fixall` to see which files would be rewritten (each is printed as `[dry-run] would rewrite <path>`) without touching anything on disk. Combine it with `--json` to get the same findings a real run would report, so you can review the diff a rewrite would produce before committing to it.

> **Always run NormWind's autofix from a clean working tree under version control** (git or equivalent), and review the diff before committing. `--fix`/`--fixall` write through an atomic temp-file-then-rename per file, preserve Unix file modes, and refuse to replace a file that changed after it was read. A working-tree safety net (commit, stash, or branch) is still the only way to cheaply undo a rewrite you don't like. `--dry-run` is the no-risk way to preview first.

## 📁 File matching

By default NormWind scans:

```text
**/*.{vue,svelte,astro,html,htm,js,mjs,cjs,ts,jsx,tsx,mts,cts}
```

…and skips the usual generated / dependency folders. At any depth:

`.git` · `.venv` · `.next` · `.nuxt` · `.output` · `.svelte-kit` · `.astro` · `.turbo` · `cdk.out` · `dist` · `node_modules` · `storybook-static` · `test-results`

At the project root only:

`.cache` · `.tmp` · `build` · `coverage` · `dist` · `out` · `test-results` · `vendor`

Target specific paths or globs any time:

```bash
npx @lunawerx/normwind src
npx @lunawerx/normwind "src/**/*.vue"
npx @lunawerx/normwind "apps/web/**/*.{tsx,ts}"
```

Use `--` to end flag parsing when a target itself starts with a dash: `npx @lunawerx/normwind -- -weird-dir`.

A pattern that matches no lintable files now exits `2` (see [Exit codes](#exit-codes)); pass `--allow-empty` to keep the old exit-`0` behavior.

### 🙈 Ignoring paths

Two ways to skip paths beyond the built-in generated-folder list:

- **`--ignore <glob>`**: repeatable, always honored, on the CLI and via the GitHub Action's `ignore` input.
- **`.normwindignore`**: a project-local file, one glob per line, `#` for comments, read automatically from the scanned directory. A bare directory name (no glob syntax) means everything under it, the same convention `.gitignore` uses.

`.normwindignore` is deliberately **not** read in GitHub Action mode. The file is checkout-controlled, so a pull request could otherwise edit it to silence the audit on the very files that PR changes. `--ignore` flags come from the workflow author, not the checkout, so they're always honored in both modes.

### 🎯 What gets scanned

NormWind only audits and fixes class strings anchored to class-bearing attributes:

- `class="..."`, `className="..."`, `:class="..."`, and `v-bind:class="..."`: quoted values, JSX-brace values (`className={...}`), quoted strings nested inside those values (ternaries, object/array bindings), and static chunks of template literals.
- Object-property form: `{ class: "..." }` / `{ className: "..." }` when the object is passed directly to a recognized React/Vue/Preact-style render function such as `createElement`, `h`, `jsx`, or an imported alias of one of them.
- Class-string builder calls: the string arguments of `clsx`, `cx`, `cn`, `classnames`, `classNames`, `cva`, `tv`, `twMerge`, and `twJoin`, including strings nested in `cva`/`tv` variant objects, arrays, ternaries, and `cond && "..."`. Locally-aliased imports of these are resolved. Strings that aren't class lists (variant keys such as `"lg"`) are filtered out by the same shape test used everywhere else.
- Attribute names that merely *end* in `-class` (e.g. `data-class`) are excluded: only the exact attribute names above match.
- Template-literal `${...}` interpolations no longer disqualify the whole literal; static chunks around an interpolation are still processed, and partial tokens straddling an interpolation boundary (e.g. `` h-${size} ``) are never touched.
- Class strings containing a bare `*` outside `[...]`/`(...)` brackets are conservatively skipped by both the audit and the fixer.

JavaScript, TypeScript, and JSX/TSX are parsed before extraction, and Vue SFC template/script boundaries are tracked structurally. Comments, serialized markup, regex literals, interpolated template text outside class props, `title="..."` text, and unrelated `{ class: "..." }` data objects are therefore excluded. If a supported JavaScript/TypeScript source block cannot be parsed safely, the file is reported as failed and is left untouched.

**Guarantee:** strings outside real class-bearing attributes and recognized render-function props are never inspected or modified. Earlier versions scanned every quoted string in a file; that behavior is gone.

<details>
<summary><strong>🎨 Named theme variables: <code>--suggest-named-theme-vars</code> / <code>--theme-css</code> (advanced)</strong></summary>

<br/>

NormWind can rewrite class tokens that reference a Tailwind v4 `@theme` variable in their long form (`border-(--color-ink-400)`, `border-[var(--color-ink-400)]/40`, `rounded-[var(--radius-sm)]`) into the equivalent named-utility form (`border-ink-400`, `border-ink-400/40`, `rounded-sm`).

Two `@theme` patterns are supported:

**Direct pattern**: the project authors the theme key itself:

```css
@theme {
  --color-ink-400: var(--color-zinc-400);
  --radius-sm: 0.125rem;
}
```

`border-(--color-ink-400)/40` → `border-ink-400/40`, `rounded-[var(--radius-sm)]` → `rounded-sm`.

**Forwarder pattern**: the project forwards a Tailwind-namespaced theme var to a foreign root variable:

```css
@theme {
  --color-outline-variant: var(--md-sys-color-outline-variant);
}
```

`border-(--md-sys-color-outline-variant)` → `border-outline-variant`.

Both rewrites are gated by a per-token CSS rule-body equivalence check: NormWind asks Tailwind to compile both candidates and only emits the rewrite when the produced rule bodies are byte-equivalent (after substituting the forwarder, where applicable). Ambiguous forwarders, unknown variables, and prefix-mismatches (e.g. `rounded-(--color-ink-400)`: `rounded-` is not a color utility) are silently skipped.

**Audit** (opt-in via flag):

```bash
npx @lunawerx/normwind \
  --suggest-named-theme-vars \
  --theme-css src/assets/css/theme.css \
  --json
```

**Fix** (auto-engaged when `--theme-css` is provided):

```bash
npx @lunawerx/normwind \
  --fixall \
  --theme-css src/assets/css/theme.css
```

The audit suggestion flag is intentionally still opt-in to preserve the existing public audit contract. During `--fix`/`--fixall` the safety gate is the per-token equivalence check, so passing `--theme-css` alone is enough. When neither `--theme-css` nor `--suggest-named-theme-vars` is passed, NormWind's output is identical to v3.0.0; existing CI pipelines are unaffected.

</details>

## 🗂️ The bundled canonical snapshot

NormWind ships a generated Tailwind canonical-replacement snapshot so your first run is fast and deterministic: no cold-boot compilation, and nothing generated is written into your project:

- `docs/reference/canonical-replacements.json`
- `docs/reference/canonical-replacements.md`

It's generated from Tailwind's own canonicalization engine for the exact Tailwind version this package bundles. At runtime, NormWind resolves a Tailwind v4 installation from the scanned project's working directory first and uses the bundled version only as a standalone fallback. That keeps autofixes aligned with the Tailwind version that will actually build the project.

**Lookup order:**

1. A project-local snapshot at `docs/reference/canonical-replacements.json`, if present.
2. The package-bundled snapshot, only when its Tailwind version matches the active project/fallback engine.
3. The active Tailwind version's live design-system canonicalizer, for cache misses or a missing/mismatched snapshot.

Disk-cache entries are validated against the installed Tailwind version before use and are written atomically. To keep scans of untrusted code resource-bounded, a single run refuses to send more than 1,000 unique cache misses through Tailwind's live canonicalizer; that condition is reported as a runtime error instead of risking a Node out-of-memory crash.

Tailwind 4.0 does not expose the canonicalization API used by newer v4 releases. NormWind still audits and fixes shorthand groups on 4.0, but safely leaves arbitrary-value classes unchanged instead of applying newer bundled semantics.

Maintainers can regenerate and verify it:

```bash
npm run canonical:extract   # regenerate
npm run canonical:check     # verify (deterministic, CI-safe)
```

## 🤖 In CI

### GitHub Action

Add inline annotations and fail a pull request when shorthand or canonical findings exist:

```yaml
name: NormWind

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  tailwind-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - uses: LunarWerxs/NormWind@v3
```

The Action is bundled, cross-platform, and read-only. It needs no API token, performs no runtime package installation, emits inline annotations plus a job summary, and writes a machine-readable JSON report to the runner. The `report-path` output remains available to later steps in the same job, where you can inspect it or pass it to your artifact uploader.

For PR safety, Action mode treats the checkout strictly as data: it does not execute repository dependencies or tools, does not trust a repository-provided NormWind snapshot, and always uses the Tailwind engine bundled with that Action release. The standalone CLI retains project-version-aware Tailwind resolution for trusted local use.

Pin `@v3.7.0` or the release commit SHA instead of `@v3` when you require an immutable dependency.

<details>
<summary><strong>Action inputs and outputs</strong></summary>

<br/>

Inputs:

| Input | Default | Purpose |
| ----- | ------- | ------- |
| `working-directory` | `.` | Directory to scan, relative to the repository root. |
| `patterns` | all supported files | Newline-delimited file paths, directories, or globs. |
| `theme-css` | none | Tailwind CSS entry file used to resolve project theme variables. |
| `suggest-named-theme-vars` | `false` | Suggest named theme utilities; requires `theme-css`. |
| `fail-on-findings` | `true` | Fail CI when normalization findings exist. |
| `max-annotations` | `10` | Inline annotation cap from `0` to `50`; every finding remains in the summary/report. |
| `ignore` | none | Newline-delimited globs to skip. A `.normwindignore` file in the checkout is deliberately ignored in Action mode (the checkout is untrusted input), so use this workflow-authored input instead. |
| `sarif-file` | none | Path, relative to the working directory, to write a SARIF 2.1.0 report to. Pair it with `github/codeql-action/upload-sarif` to surface findings in code scanning. |

Outputs: `version`, `finding-count`, `linted-files`, `result`, `exit-code`, `report-path`, and `sarif-path` (set only when `sarif-file` was provided).

</details>

### Any CI provider

Use the CLI directly anywhere Node.js is available:

```bash
npx @lunawerx/normwind --json
```

That's it: exit code `1` fails the job, and the JSON payload is stable enough to feed a custom reporter or annotation step.

## 🧰 What's in the box

The npm package intentionally publishes only runtime assets, brand assets, and reference docs:

- `bin/normwind.mjs`
- `docs/reference/canonical-replacements.json`
- `docs/reference/canonical-replacements.md`
- `assets/`: logos and the share card
- `README.md`
- `package.json`

Tests and fixtures live in the source repo but are excluded from the packed tarball.

<details>
<summary><strong>🧑‍💻 Development &amp; maintainer commands</strong></summary>

<br/>

Run the full pre-push verification suite:

```bash
npm test          # alias: npm run prepush
```

The pre-push suite verifies package metadata, canonical-snapshot integrity, canonical drift, regression fixtures, live-Tailwind-vs-snapshot parity, CLI audit/fix smoke behavior, and `npm pack --dry-run` contents.

Other useful scripts:

```bash
npm run test:regression          # run the regression fixtures
npm run test:regression:update   # update fixtures after an intentional change
npm run test:compare             # live canonicalizer vs bundled snapshot
npm run canonical:extract        # regenerate canonical replacement files
npm run canonical:check          # verify canonical replacement files are current
```

</details>

<details>
<summary><strong>📐 A note on Tailwind v4 &amp; eslint-plugin-tailwindcss</strong></summary>

<br/>

NormWind deliberately uses `eslint-plugin-tailwindcss`'s **static group data** instead of invoking the plugin's `enforces-shorthand` rule directly. Under Tailwind v4, the plugin's config path can return only `separator` and `prefix`, which prevents the rule from resolving many utility families. NormWind keeps the useful upstream group data while using its own Tailwind v4-compatible matcher and Tailwind's own v4 canonicalization engine, so you get the plugin's knowledge without its v4 blind spots.

</details>

## 📜 Changelog

<details>
<summary><strong>v3.8.0</strong>: 2026-08-09 · merge-safety correctness fix, SARIF reporter, ignore files, broader scanning</summary>

<br/>

- **Merge-safety gate for shorthand merges (correctness fix)**: a merge such as `ml-2 mr-2` → `mx-2` is now applied only when Tailwind's own engine confirms the before and after class lists render identical CSS. Tailwind emits utilities in its own order, not authoring order, so a merge sharing a group with another utility at a different value (a pre-existing `mx-8` alongside `ml-2 mr-2`) could previously hand that other utility the win and silently change the rendered layout. `--fix`/`--fixall` now skip any merge that isn't provably safe instead of applying it blind; this closes a real path to a silent visual regression from `--fix`.
- **New flags**: `--reporter <text|json|sarif>` (`sarif` emits SARIF 2.1.0 for GitHub code scanning; `--json` remains an alias for `--reporter json`), `--ignore <glob>` (repeatable), `--allow-empty` (exit `0` instead of `2` when a pattern matches nothing), and `--` to end flag parsing so a target can start with a dash.
- **`.normwindignore`**: a project-local ignore file (one glob per line, `#` comments, a bare directory name means everything under it) is now read automatically from the scanned directory. It is deliberately not read in GitHub Action mode, since the file is checkout-controlled and a pull request could otherwise silence the audit on the very files it changed; `--ignore` flags are always honored in both modes.
- **Broader file matching**: `.svelte`, `.astro` (frontmatter skipped, markup scanned), and plain `.html`/`.htm` join the default scan alongside Vue/JS/TS. The generated-folder ignore list dropped project-specific paths and now covers `.next`, `.nuxt`, `.output`, `.svelte-kit`, `.turbo`, and `storybook-static` at any depth, plus root-only build folders such as `build`, `coverage`, `out`, and `vendor`.
- **Class-string builders are scanned**: `clsx`, `cx`, `cn`, `classnames`, `classNames`, `cva`, `tv`, `twMerge`, and `twJoin` calls, including strings nested in `cva`/`tv` variant objects, arrays, ternaries, and `cond && "..."`, with locally-aliased imports resolved.
- **`--fix` covers every markup format**: `.svelte`, `.astro`, and `.html`/`.htm` join `.vue` in the safe default fixer, not just `--fixall`.
- **Composite equivalences are now fixable**: `truncate`, `place-content-*`, `place-items-*`, and `place-self-*` findings are applied by `--fix`/`--fixall` instead of being audit-only, so a fix-then-audit CI loop can actually reach exit `0`.
- **Stricter exit codes**: a pattern matching no lintable files now exits `2` instead of `0` (`--allow-empty` restores the old behavior), and `--fix`/`--fixall`/`--dry-run` combined with a canonical-maintenance flag, or `--dry-run` without `--fix`/`--fixall`, now exits `2` instead of silently doing nothing.

</details>

<details>
<summary><strong>v3.7.0</strong>: 2026-08-01 · GitHub Marketplace Action</summary>

<br/>

- **Native GitHub review feedback**: the new `NormWind Tailwind Audit` Action emits file-and-line annotations, a complete job summary, stable outputs, and a machine-readable JSON report. Findings can fail the job or run in advisory mode; incomplete scans always fail closed.
- **Self-contained and least privilege**: the JavaScript Action bundles NormWind, Tailwind, Babel, and its reporting runtime; it installs nothing on the runner, requires no secret or write permission, strips inherited secrets from its scanner process, never executes checkout-provided dependencies/tools, and confines source/theme reads to the checked-out workspace.
- **Reproducible Action releases**: deterministic bundle generation, committed third-party license inventories, bundle-drift tests, and a pre-install local-Action smoke step now gate CI and releases. Moving Action tags no longer trigger duplicate npm publications.
- **Dependency hardening**: the transitive PostCSS version is refreshed past its source-map path-traversal advisory, leaving `npm audit` clean.

</details>

<details>
<summary><strong>v3.6.2</strong>: 2026-07-24 · project-version-aware Tailwind safety</summary>

<br/>

- **Project Tailwind wins**: canonicalization now uses the Tailwind v4 installation resolved from the scanned project's working directory, with bundled Tailwind 4.3.3 retained as the zero-config fallback.
- **Older v4 projects stay semantically stable**: Tailwind 4.1/4.2 projects no longer receive 4.3-only rewrites such as the new system-font stack collapsing to their older `font-sans` value. Snapshot and disk-cache entries are accepted only when their Tailwind version matches the active engine.
- **Safe Tailwind 4.0 behavior**: shorthand auditing remains available, while arbitrary-value canonicalization becomes a no-op because Tailwind 4.0 does not expose the required canonicalization API.
- **Compatibility regression coverage**: the pre-push suite now proves both project-local engine selection and the Tailwind 4.0 no-op fallback without requiring network access.

</details>

<details>
<summary><strong>v3.6.1</strong>: 2026-07-24 · Tailwind CSS 4.3 support</summary>

<br/>

- **Tailwind CSS 4.3.3 support**: NormWind now bundles and validates against the current Tailwind 4.3 patch while retaining Node 20 compatibility.
- **Canonical snapshot regenerated**: the bundled reference now contains 12,438 replacements generated by Tailwind 4.3.3. Its new case-insensitive arbitrary hex-color canonicalization (`bg-[#FFF]` → `bg-white`) is covered by an end-to-end regression.
- **Dependency automation fixed**: routine minor/patch updates remain grouped, Tailwind updates get dedicated compatibility PRs, and the incompatible Babel 8 / `eslint-plugin-tailwindcss` 4 majors are deferred while Node 20 and the current group-data integration remain supported.
- **GitHub Actions update**: `actions/setup-node` v7 is adopted at a full commit SHA after passing the complete Ubuntu/Windows and Node 20/22 matrix.

</details>

<details>
<summary><strong>v3.6.0</strong>: 2026-07-24 · syntax-aware safety, bounded canonicalization, release hardening</summary>

<br/>

- **Syntax-aware extraction**: JavaScript, TypeScript, JSX, and TSX are parsed before class strings are collected, while Vue SFC template/script boundaries are tracked structurally. Comments, serialized markup, regex literals, interpolations outside class props, and unrelated `{ class: "..." }` data objects are no longer audit/fix candidates. Render-prop objects remain supported for recognized `h`/`createElement`/JSX-runtime calls and imported aliases.
- **Fail-closed autofix**: unparseable source, oversized files, read/stat failures, symlinks, concurrent editor saves, and per-file transform/write failures are surfaced with exit `2`; unsafe files are left untouched while independent files continue. Atomic rewrites preserve Unix mode bits.
- **Bounded canonicalization and cache validation**: live Tailwind canonicalization is capped, on-disk cache data is type/size validated, stale snapshot entries are compacted away, and cache replacement is atomic. Generated canonical data now encodes candidate spaces correctly and includes an arbitrary-color regression.
- **Audit/fix parity**: reverse size shorthands, arbitrary variants, equal width/height values, and named theme-variable import ordering now follow the same matching rules in audit and fix paths.
- **Target and output correctness**: explicit directories and glob patterns are unioned, `lintedFiles` reflects successfully scanned files, skipped/failed work is summarized, and `--dry-run --json` keeps stdout machine-readable.
- **Release and CI hardening**: GitHub Actions are commit-SHA pinned with least-privilege permissions and timeouts, Dependabot covers npm and Actions, the release helper validates strict SemVer, stages/pushes exact release refs atomically, keeps GitHub credentials out of remotes/arguments, rolls back failed bumps, and uses network timeouts.

</details>

<details>
<summary><strong>v3.5.0</strong>: 2026-07-09 · fault isolation, classifier parity, --dry-run, corner-family merger</summary>

<br/>

- **Fault-isolated `--fix`/`--fixall`**: a per-file try/catch means one `EBUSY`/`EPERM`/transform throw no longer aborts the whole batch; a fixed/skipped/failed summary prints, with a distinct exit code when anything failed.
- **Unified audit/fix classifiers**: `isLikelyTailwindUtility`/`isLikelyFixUtility` and `matchUtilityToBody`/`matchFixBodyValue` now share matching logic (bracket-variant and bare-body parity), closing gaps where `--fix` missed findings the audit reported.
- **`--dry-run`**: pair with `--fix`/`--fixall` to see which files would be rewritten without touching disk.
- **Scanner guards**: the fallback walker now skips oversized files and detects symlink loops instead of hanging or erroring.
- **Corner and four-sides family merger rewritten**: the fixer now uses the same family-table clustering the audit uses, so corner pairs (`rounded-tl` + `rounded-tr` → `rounded-t`), border side pairs (`border-t` + `border-b` → `border-y`), and complete four-sides sets (`rounded-t/r/b/l` → `rounded`, `border-t/r/b/l` → `border`) converge instead of persisting as unfixable findings.

</details>

<details>
<summary><strong>v3.4.2</strong>: 2026-07-06</summary>

<br/>

- **New brand**: NormWind logo, wordmarks, and share card (`assets/`), plus a redesigned README.
- **MIT LICENSE file** added (the package always declared MIT; now the text ships too).
- Brand assets live in the repo only: the npm tarball stays lean (bin, canonical snapshot, README, LICENSE).

</details>

<details>
<summary><strong>v3.4.1</strong>: 2026-07-06</summary>

<br/>

- **npm publishing moved to GitHub Actions with provenance.** Pushing a `v*` tag triggers the `Release` workflow, which re-runs the full test suite and then `npm publish --provenance`: packages now carry a verified build attestation linking them to this repo, commit, and workflow. `scripts/release.py` still drives the release locally (tests, bump, tag, GitHub release) but now waits for the Actions publish and verifies the version is live on the registry; `--publish-locally` remains as a fallback. Local releases no longer need an npm token.
- **Line-ending hardening in the shipped binary.** The `--check-canonical` drift check is tolerant of CRLF checkouts (git `autocrlf` on fresh Windows clones previously failed it), and `.gitattributes` pins the generated artifacts to LF. The v3.4.0 npm tarball already contained this fix; the tag now does too.
- **release.py pre-flight hardening**: validates GitHub credentials (with `gh` CLI token fallback) before any mutation, runs the npm dry-run at the new version, never echoes tokens, and always restores the clean git remote URL.

</details>

<details>
<summary><strong>v3.4.0</strong>: 2026-07-06</summary>

<br/>

- **Anchored class-string extraction**: audit and fix now only inspect `class=`, `className=`, `:class=`, and `v-bind:class=` attribute values (quoted or JSX-brace form, including nested quoted strings inside bindings and static template-literal chunks) plus the object-property form `{ class: "..." }` / `{ className: "..." }`. The previous behavior (scanning every quoted string in a file) is gone; it could rewrite unrelated code such as SQL strings, `title="..."` text, or `data-class` attributes. Attribute names that merely *end* in `-class` are excluded.
- **One shared extractor**: audit and fix now use the same extraction path, so "audit clean" guarantees "`--fix` is a no-op." Class strings containing a bare `*` outside `[...]`/`(...)` brackets are conservatively skipped by both.
- **Atomic writes**: `--fix`/`--fixall` now write through a temp file + rename, so a crash mid-write can no longer truncate a source file.
- **Order-independent padding merge**: `pt-4 pb-4 pl-4 pr-4` now fully merges to `p-4` regardless of declaration order (previously order-dependent).
- **Template literals**: `${...}` interpolations no longer disqualify the whole literal; static chunks are still audited/fixed, and partial tokens straddling an interpolation boundary (e.g. `` h-${size} ``) are never touched.
- **New flags**: `-v`/`--version` prints the version and exits `0`. Unknown flags now error with exit `2` instead of being silently ignored. A `--theme-css` with a missing value errors; a `--theme-css` path that can't be read now fails loud (exit `2`) instead of silently disabling the feature. Patterns that match no files print a warning.
- **`-h` now works**: previously only `--help` was recognized.
- **Documented exit codes**: `0` no findings, `1` findings, `2` usage/runtime error.
- **Version banner fixed**: the CLI now reads its version from `package.json` at runtime instead of a hardcoded string (the banner had been stuck on `v3.1.1` for two releases).
- **Portable canonical artifacts**: `docs/reference/canonical-replacements.*` no longer embed an absolute machine path or the tool version, so `npm test`/`--check-canonical` passes on any machine.
- **File discovery fixes**: ripgrep returning "no matches" is no longer misread as "ripgrep is missing"; the no-`rg` fallback now applies glob patterns properly, and its ignore list matches ripgrep's (`.venv` and `.git` added).
- **Trailer text**: the text report's trailer no longer references `npm run lint` (a project-specific script); it now suggests `--fix`/`--fixall`.

</details>

<details>
<summary><strong>v3.3.0</strong>: 2026-05-08 · direct-theme-key resolver, w/h order fix, multi-line variant brackets</summary>

<br/>

- **Direct-theme-key resolver**: `--suggest-named-theme-vars` now collapses utilities that reference a registered `@theme` variable directly (e.g. `border-(--color-ink-400)/40`, `text-(--color-ink-700)`, `rounded-[var(--radius-sm)]`) to the named form (`border-ink-400/40`, `text-ink-700`, `rounded-sm`). Previously the resolver only handled the forwarder pattern; it now also handles the direct pattern where the project authors the theme key itself. The CSS rule-body equivalence check still gates every emitted suggestion, so safety is unchanged.
- **Modifier-aware**: opacity-style modifiers such as `/40` and `!` important markers now flow through the named-theme-var resolver: `border-(--color-ink-400)/40` round-trips to `border-ink-400/40` instead of being silently skipped.
- **Bracket-form audit coverage**: the audit's arbitrary-token regex now matches an optional trailing `/<modifier>` suffix, so tokens like `border-[var(--color-ink-400)]/40` reach the canonicalizer. The audit also chains Tailwind's canonicalizer into the named-theme resolver, so a single finding emits the most specific safe rewrite.
- **Theme CSS auto-engages the resolver during fix**: `--fix`/`--fixall` now apply named-theme-var rewrites whenever `--theme-css` is provided; the explicit `--suggest-named-theme-vars` flag is no longer required at fix time.
- **Order-agnostic `w`/`h` → `size` shorthand**: height-first authoring (`h-5 w-5`, `hover:h-8 hover:w-8`) now collapses to `size-5`, `hover:size-8` alongside the width-first form.
- **Multi-line class strings with `data-[state=…]:` variants are no longer skipped**: the operator-character heuristic now ignores characters inside Tailwind's `[…]` and `(…)` brackets, so attribute-style variants such as `data-[state=open]:text-(--color-ink-1000)` and `aria-[expanded=true]:rotate-180` no longer suppress fixes.
- **New regression fixtures**: `reverse-size-shorthand`, `multiline-with-data-attr`, and `named-theme-var-direct`. The regression harness now auto-supplies `--theme-css`/`--suggest-named-theme-vars` for any fixture that ships a sibling `theme.css`, and the prepush gate counts fixtures dynamically.

</details>

<details>
<summary><strong>v3.2.0</strong>: 2026-05-08 · Vue :class extraction, multi-line class attrs, packaging hygiene</summary>

<br/>

- **Vue dynamic bindings**: the class-attribute extractor now matches `:class="…"` and `v-bind:class="…"` in addition to plain `class="…"`, so utilities embedded in Vue ternaries and object/array bindings are audited and fixed alongside their static siblings.
- **Multi-line class attributes**: the extractor no longer terminates at the first newline, so class lists wrapped across multiple lines (common in templates and JSX) are picked up in full.
- **Internal refactor**: class-string extraction was split into focused helpers for readability; no behavior change beyond the two items above.
- **Packaging hygiene**: the `files` whitelist lists `bin/normwind.mjs` explicitly, and the prepush gate fails the publish if any `*.bak`/`*.orig`/`*.swp`/`*.tmp` straggler lands in the tarball.
- **Single source of truth**: the parent/`repo-clone` wrapper layout collapsed into a single flat repo; `bin/normwind.mjs` is the only CLI source.

</details>

<details>
<summary><strong>v3.1.1</strong> · named-theme-var flag, theme-css entry inlining</summary>

<br/>

- **`--suggest-named-theme-vars` flag (opt-in)**: detects `utility-(--var-name)` classes and, when the project's `@theme` defines a single-step forwarder, suggests (or rewrites with `--fixall`) the equivalent named-theme class.
- **`--theme-css <path>` flag**: points NormWind at your Tailwind entry CSS; it recursively inlines local `@import` directives so a re-exporting `style.css` is fully resolved. Package imports like `@import "tailwindcss"` are skipped.
- **Hash-namespaced resolver cache**: the on-disk cache key is `themevar:<sha1(resolvedCss)>:<rawToken>`, so two projects with disagreeing forwarders never poison each other's cache.
- **Fail-loud on missing `@theme`**: a one-line diagnostic instead of silently producing zero suggestions.
- **Runtime-equivalence gating**: suggestions are emitted only when both candidates compile to byte-equivalent CSS rule bodies.
- **Single-token paren-form support** in `.vue` files, and **zero default change** when the flag is omitted.

</details>

<details>
<summary><strong>v3.1.0</strong>: 2026-04-29 · bundled canonical snapshot, CI drift check</summary>

<br/>

- **Bundled canonical snapshot**: ships `docs/reference/canonical-replacements.json` (12,069 entries) generated from Tailwind's own `designSystem.canonicalizeCandidates` engine; no cold boot on first run.
- **`--check-canonical` flag**: exits `1` when the bundled snapshot is missing or stale; CI-suitable.
- **`canonical:extract` / `canonical:check` scripts**: the maintainer workflow for regenerating and verifying the snapshot.
- **7-fixture regression harness**, **live-vs-snapshot parity test**, and a **7-check pre-push suite**.
- **Tailwind v4 note**: documents why the `eslint-plugin-tailwindcss` rule is bypassed under v4.

</details>

<details>
<summary><strong>v3.0.0</strong> · initial public release</summary>

<br/>

Initial public release. Shorthand auditor and autofixer for Tailwind CSS utility classes.

</details>

## 🔍 How it compares

NormWind sits next to two tools people already reach for when tidying Tailwind class strings, rather than replacing either:

- **[`prettier-plugin-tailwindcss`](https://github.com/tailwindlabs/prettier-plugin-tailwindcss)** (Tailwind Labs' own Prettier plugin) sorts class names into Tailwind's recommended order. By its own documentation it does not merge shorthand combinations or rewrite arbitrary values. NormWind does the opposite job, and the two compose fine in the same project: let Prettier sort, let NormWind shorten.
- **[`eslint-plugin-tailwindcss`](https://github.com/francoismassart/eslint-plugin-tailwindcss)**'s `enforces-shorthand` rule is an ESLint rule with its own autofix, and NormWind reuses its utility-group data rather than duplicating it (see "A note on Tailwind v4 & eslint-plugin-tailwindcss" above). But the rule runs inside an ESLint config, and under Tailwind v4 its config path can return only `separator` and `prefix`, which keeps it from resolving many utility families. NormWind runs standalone, as a CLI or GitHub Action, with no ESLint setup required, and also canonicalizes arbitrary values via Tailwind's own engine, which shorthand-focused linting doesn't cover.

## ❓ FAQ

**Is NormWind free?**
Yes. NormWind is free, open-source software licensed under MIT. Install it with npm, or skip installation entirely and run it with npx. The GitHub Action is also free to use and requires no API token, no signup, and no paid tier; it's published on the GitHub Marketplace and the source is on GitHub.

**Does it require any configuration?**
No. NormWind is zero-config: there's no rules file to write, no sort order to choose, and no plugins to register. Point it at a project, a specific path, or a glob and it audits or fixes immediately. Optional flags like `--ignore`, `--theme-css`, or a `.normwindignore` file exist, but none are required to get started.

**Does it modify my files automatically, or just report issues?**
By default, running `normwind` only audits and reports findings; it never writes to disk unless you pass `--fix` or `--fixall`. `--fix` rewrites markup formats (Vue, Svelte, Astro, HTML) safely; `--fixall` extends that to JS/TS files too. Both write atomically and preserve file modes, but you should still run them from a clean, version-controlled working tree.

**Is my code sent anywhere, or does it need an API key?**
No. NormWind runs entirely against your local files and your project's installed Tailwind engine; it needs no API token or account. The GitHub Action bundles NormWind, Tailwind, and Babel itself, installs nothing on the runner, and strips inherited secrets from its scanner process, so it has no documented path to send code out during a scan.

**What are the system requirements?**
NormWind requires Node.js 20 or later, per its `package.json` engines field. It works against Tailwind CSS v4 projects: full shorthand and arbitrary-value canonicalization on Tailwind 4.1 through 4.3, and shorthand-only auditing on 4.0, since that release doesn't expose the canonicalization API NormWind depends on for arbitrary values.

**Does it support Tailwind CSS v3?**
The repo documents support for Tailwind CSS v4 only, spanning 4.0 through the bundled 4.3.3. Arbitrary-value canonicalization relies on Tailwind's `designSystem.canonicalizeCandidates` engine, a v4 API. No v3 compatibility is documented in the README or changelog, so treat NormWind as a v4-only tool unless a future release states otherwise.

**How is it different from `prettier-plugin-tailwindcss`?**
Tailwind's own Prettier plugin sorts class names into a recommended order; by its own documentation it doesn't merge shorthand or touch arbitrary values. NormWind does the opposite job: it collapses verbose combinations like `px-4 py-4` into `p-4` and rewrites arbitrary values like `rounded-[24px]` into `rounded-3xl`. The two tools solve different problems and can be used together.

**What happens if a rewrite might change my page's rendered CSS?**
NormWind skips it. Before merging classes like `ml-2 mr-2` into `mx-2`, it compiles both the before and after class lists through Tailwind's own engine and compares the resulting CSS declarations. If another utility in the same group (say, an existing `mx-8`) would change which value wins, the merge is skipped rather than applied blind.

## 📄 License

[MIT](LICENSE) © [LunarWerx](https://github.com/LunarWerxs)

Made by [LunarWerx Studios](https://lunarwerx.com). Check out sibling projects [RepoYeti](https://repoyeti.com), [SageThumbs](https://sagethumbs.lunarwerx.com), and [QuickDictate](https://quickdictate.lunarwerx.com).

<div align="center">
<br/>
<img src="https://raw.githubusercontent.com/LunarWerxs/NormWind/main/assets/normwind-icon.png" alt="" width="52">
<br/>
<sub><strong>NormWind</strong>: keep your Tailwind classes calm.</sub>
</div>
