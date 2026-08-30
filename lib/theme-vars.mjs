// Named theme-var resolution (opt-in via --suggest-named-theme-vars).

import { cssRuleBodiesAreEquivalent } from "./css.mjs";
import { buildFixToken, parseFixToken } from "./tokens.mjs";
import {
    CANONICAL_MEMO,
    rememberDynamicCacheEntry,
    validateCacheAgainstTailwindVersion,
} from "./canonical-cache.mjs";
import { loadAugmentedDesignSystem, loadTailwindDesignSystem } from "./design-system.mjs";

// ---------------------------------------------------------------------------
// Named theme-var resolver  (opt-in via --suggest-named-theme-vars)
//
// Detects classes like `border-(--md-sys-color-outline-variant)` and suggests
// `border-outline-variant` *only when* the design system has a theme variable
// (e.g. `--color-outline-variant`) whose value forwards to that root var AND
// the two classes produce byte-identical CSS. This guarantees zero behavioral
// regression for the suggested replacement at the moment of analysis.
// ---------------------------------------------------------------------------

let themeVarResolverPromise = null;
let themeVarResolverThemeCssPath = null;

// rawTokenInput -> resolved replacement string (or the same input when no safe
// replacement exists). Stored alongside CANONICAL_MEMO using a key prefix so
// disk-cache invalidation on Tailwind version change still applies.
const THEME_VAR_CACHE_PREFIX = "themevar:";

function extractParenVarName(utility) {
    // Matches the trailing `(--name)` form, with optional `!` prefix the parser
    // strips earlier and an optional `/<modifier>` suffix (e.g. `/40` opacity).
    // The modifier is preserved verbatim so the resolver can rebuild
    // `border-(--color-ink-400)/40` -> `border-ink-400/40` with byte-identical CSS.
    const m = /^(?<prefix>[a-z][a-z0-9-]*)-\(--(?<name>[a-z0-9-]+)\)(?<modifier>\/[^\s]+)?$/i.exec(utility);
    if (m) {
        return {
            utilityPrefix: m.groups.prefix,
            varName: `--${m.groups.name}`,
            modifier: m.groups.modifier ?? "",
        };
    }
    const b = /^(?<prefix>[a-z][a-z0-9-]*)-\[var\(--(?<name>[a-z0-9-]+)\)\](?<modifier>\/[^\s]+)?$/i.exec(utility);
    if (b) {
        return {
            utilityPrefix: b.groups.prefix,
            varName: `--${b.groups.name}`,
            modifier: b.groups.modifier ?? "",
        };
    }
    return null;
}

// The active resolver's theme-css hash, exposed so the pre-warm step and the
// hot-loop fallback can compute the same per-project cache namespace. Set
// when a resolver successfully loads; null when no theme CSS is in play (the
// resolver then operates against Tailwind's own design system only).
let activeThemeCssHash = null;

function buildThemeVarCacheKey(rawToken, themeCssHash) {
    if (themeCssHash) {
        return `${THEME_VAR_CACHE_PREFIX}${themeCssHash}:${rawToken}`;
    }
    return `${THEME_VAR_CACHE_PREFIX}${rawToken}`;
}

// Build a map: forwarded-root-var (e.g. `--md-sys-color-outline-variant`)
// -> Tailwind theme key (e.g. `--color-outline-variant`).
// Only single-step forwarders of the form `var(--x)` (with optional
// whitespace) are eligible. Anything more complex is skipped to keep
// the equivalence check trivial.
function buildForwardedToThemeKeyMap(designSystem) {
    const forwardedToThemeKey = new Map();
    for (const [key, entry] of designSystem.theme.values.entries()) {
        if (!entry || typeof entry.value !== "string") continue;
        const m = /^\s*var\(\s*(--[a-z0-9-]+)\s*\)\s*$/i.exec(entry.value);
        if (!m) continue;
        const forwarded = m[1];
        if (forwardedToThemeKey.has(forwarded)) {
            // Multiple theme vars forward to the same root var -- ambiguous.
            forwardedToThemeKey.set(forwarded, null);
        } else {
            forwardedToThemeKey.set(forwarded, key);
        }
    }
    return forwardedToThemeKey;
}

// Build a quick lookup: theme key -> the single var() it forwards
// to (e.g. "--color-outline-variant" -> "--md-sys-color-outline-variant").
// Only single-var forwarders are stored, matching the population logic
// above. Used by the equivalence check to verify the candidate CSS
// differs from the original only by substituting `var(--themeKey)`
// for `var(--forwarded)`.
function buildThemeKeyToForwardedMap(forwardedToThemeKey) {
    const themeKeyToForwarded = new Map();
    for (const [forwarded, themeKey] of forwardedToThemeKey.entries()) {
        if (typeof themeKey === "string") {
            themeKeyToForwarded.set(themeKey, forwarded);
        }
    }
    return themeKeyToForwarded;
}

// The resolver returned by getThemeVarResolver(). Pulled out to a top-level
// function (instead of a closure literal) so its own branches are scored on
// their own nesting, not stacked on top of the async IIFE that builds it.
function resolveThemeVarToken(rawToken, { designSystem, forwardedToThemeKey, themeKeyToForwarded, themeCssHash }) {
    if (!rawToken || typeof rawToken !== "string") return rawToken;

    const cacheKey = buildThemeVarCacheKey(rawToken, themeCssHash);
    const cached = CANONICAL_MEMO.get(cacheKey);
    if (cached !== undefined) {
        return cached === "" ? rawToken : cached;
    }

    const recordMiss = () => {
        rememberDynamicCacheEntry(cacheKey, "");
        return rawToken;
    };

    const token = parseFixToken(rawToken);
    const parsed = extractParenVarName(token.utility);
    if (!parsed) return recordMiss();

    // Resolve `parsed.varName` to a Tailwind theme key. Two pathways:
    //   1. Forwarder pattern: user authored a root var that the design
    //      system forwards from a Tailwind-namespaced theme var
    //      (`--color-x: var(--md-sys-color-x)` -> author writes
    //      `--md-sys-color-x`, theme key is `--color-x`).
    //   2. Direct pattern: user authored the theme key itself
    //      (`--color-ink-400` is registered in @theme; author writes
    //      `border-(--color-ink-400)`, theme key is `--color-ink-400`).
    // Both reduce to "theme key whose namespace prefix is dropped to
    // form the named-utility fragment". The Tailwind-generated CSS
    // body is byte-identical for both forms when the candidate is
    // valid, and `candidatesToCss` returns undefined when the
    // candidate is not a valid utility -- so the equivalence check
    // is the safety gate for both pathways.
    let themeKey = forwardedToThemeKey.get(parsed.varName);
    if (!themeKey || typeof themeKey !== "string") {
        const direct = designSystem.theme.values.get(parsed.varName);
        if (direct && typeof direct.value === "string") {
            themeKey = parsed.varName;
        }
    }
    if (!themeKey || typeof themeKey !== "string") return recordMiss();

    // Theme keys look like `--<namespace>-<fragment>`. Drop the
    // namespace to get the fragment used in named utility classes.
    const fragmentMatch = /^--[a-z0-9]+-(.+)$/i.exec(themeKey);
    if (!fragmentMatch) return recordMiss();
    const fragment = fragmentMatch[1];
    if (!fragment) return recordMiss();

    const candidateUtility = `${parsed.utilityPrefix}-${fragment}${parsed.modifier}`;
    const candidateRaw = buildFixToken({
        variants: token.variants,
        utility: candidateUtility,
        important: token.important,
    });

    let originalCss;
    let candidateCss;
    try {
        originalCss = designSystem.candidatesToCss([token.raw])?.[0] ?? "";
        candidateCss = designSystem.candidatesToCss([candidateRaw])?.[0] ?? "";
    } catch {
        return recordMiss();
    }
    if (!originalCss || !candidateCss) return recordMiss();
    if (!cssRuleBodiesAreEquivalent(originalCss, candidateCss, themeKeyToForwarded)) {
        return recordMiss();
    }

    rememberDynamicCacheEntry(cacheKey, candidateRaw);
    return candidateRaw;
}

async function getThemeVarResolver({ themeCssPath = null } = {}) {
    // If the caller passes a different themeCssPath than the cached one, drop
    // the cached resolver so we rebuild against the new design system.
    if (themeVarResolverPromise && themeVarResolverThemeCssPath !== themeCssPath) {
        themeVarResolverPromise = null;
    }
    if (!themeVarResolverPromise) {
        themeVarResolverThemeCssPath = themeCssPath;
        themeVarResolverPromise = (async () => {
            validateCacheAgainstTailwindVersion();
            const augmented = themeCssPath
                ? await loadAugmentedDesignSystem(themeCssPath)
                : await loadTailwindDesignSystem();
            const { designSystem } = augmented;
            const themeCssHash = augmented.themeCssHash || null;
            activeThemeCssHash = themeCssHash;

            const forwardedToThemeKey = buildForwardedToThemeKeyMap(designSystem);
            const themeKeyToForwarded = buildThemeKeyToForwardedMap(forwardedToThemeKey);

            return (rawToken) =>
                resolveThemeVarToken(rawToken, { designSystem, forwardedToThemeKey, themeKeyToForwarded, themeCssHash });
        })();
    }
    return themeVarResolverPromise;
}




function lookupThemeVarReplacementFromMemo(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return undefined;
    const cached = CANONICAL_MEMO.get(buildThemeVarCacheKey(rawToken, activeThemeCssHash));
    if (cached === undefined) return undefined;
    return cached === "" ? rawToken : cached;
}

function tokenLooksLikeNamedThemeVarCandidate(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return false;
    // Accept an optional trailing `/<modifier>` (e.g. opacity) and an optional
    // trailing `!` important marker. Both forms are valid Tailwind syntax and
    // must round-trip through the resolver to keep parity between
    // `border-(--color-x)/40` and `border-x/40`.
    return (
        /-\(--[a-z0-9-]+\)(?:\/[^\s!]+)?!?$/i.test(rawToken) ||
        /-\[var\(--[a-z0-9-]+\)\](?:\/[^\s!]+)?!?$/i.test(rawToken)
    );
}

// Pass 1 of the scan pre-warms this resolver and pass 2 reuses it. A null here
// means no theme-var candidate was seen, so the design system must not be
// loaded for the second pass alone.
function peekThemeVarResolverPromise() {
    return themeVarResolverPromise;
}

// Cache keys are scoped to the theme CSS that produced them, so a caller
// probing the memo directly has to ask which theme this run resolved against.
function getActiveThemeCssHash() {
    return activeThemeCssHash;
}

export {
    buildThemeVarCacheKey,
    getActiveThemeCssHash,
    getThemeVarResolver,
    lookupThemeVarReplacementFromMemo,
    peekThemeVarResolverPromise,
    tokenLooksLikeNamedThemeVarCandidate,
};
