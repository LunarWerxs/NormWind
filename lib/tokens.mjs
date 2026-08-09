// Tailwind class-token parsing and classification. Every other
// module agrees on what a token IS because it comes from here.

// THE token parser. Both the audit and the fix path derive from this one
// implementation; they used to carry near-identical parsers with subtly
// different internal representations of the important marker, which is exactly
// the kind of duplication that lets "audit clean implies fix is a no-op" rot.
//
// `raw` is the token as authored. `normalized` is the same token with the
// legacy leading-`!` important marker rewritten to Tailwind v4's trailing form,
// which is what the fixer emits.
export function parseToken(raw) {
    let utilityPart = raw;
    const importantSuffix = utilityPart.endsWith("!") && utilityPart.length > 1;
    if (importantSuffix) {
        utilityPart = utilityPart.slice(0, -1);
    }

    let importantPrefix = utilityPart.startsWith("!") && utilityPart.length > 1;
    if (importantPrefix) {
        utilityPart = utilityPart.slice(1);
    }

    const lastColon = utilityPart.lastIndexOf(":");
    const variants = lastColon >= 0 ? utilityPart.slice(0, lastColon + 1) : "";
    let utility = lastColon >= 0 ? utilityPart.slice(lastColon + 1) : utilityPart;

    // `hover:!p-4` puts the marker after the variants rather than at the front.
    if (utility.startsWith("!") && utility.length > 1) {
        importantPrefix = true;
        utility = utility.slice(1);
    }

    const important = importantPrefix || importantSuffix;
    return {
        raw,
        normalized: `${variants}${utility}${important ? "!" : ""}`,
        variants,
        utility,
        importantPrefix,
        importantSuffix,
        important,
    };
}

export function parseClassToken(raw) {
    return parseToken(raw);
}

// Fix-side view of parseToken: `raw` is the NORMALIZED form, because that is
// what the fixer writes back and what callers diff against the input token to
// detect a marker rewrite.
export function parseFixToken(raw) {
    const token = parseToken(raw);
    return {
        raw: token.normalized,
        variants: token.variants,
        utility: token.utility,
        important: token.important,
    };
}

export function buildFixToken({ variants, utility, important }) {
    return `${variants}${utility}${important ? "!" : ""}`;
}

export function formatClass(variants, important, utility) {
    return `${variants}${utility}${important ? "!" : ""}`;
}

// Strip the contents of every `[...]` and `(...)` segment so that operator
// characters which are valid inside Tailwind arbitrary-value or theme-var
// brackets (e.g. `data-[state=open]`, `[&>svg]`, `(--my-var)`) are not
// mistaken for JSX/JS expression syntax outside the brackets.
export function stripBracketedSegments(input) {
    if (typeof input !== "string" || input.length === 0) {
        return input ?? "";
    }

    // Depth-aware scan: Tailwind arbitrary values can nest same-kind brackets
    // (named grid lines, e.g. `grid-cols-[1fr_[full]_1fr]`), which a
    // non-nesting regex only strips up to the first closer, leaving a stray
    // `]` behind. An unbalanced opener keeps its remainder verbatim so the
    // operator gates still see whatever a malformed token contains.
    let out = "";
    let depth = 0;
    let openChar = null;
    let segmentStart = -1;

    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (depth === 0) {
            out += ch;
            if (ch === "[" || ch === "(") {
                depth = 1;
                openChar = ch;
                segmentStart = i;
            }
            continue;
        }

        if (ch === openChar) {
            depth += 1;
        } else if (ch === (openChar === "[" ? "]" : ")")) {
            depth -= 1;
            if (depth === 0) {
                out += ch;
                openChar = null;
                segmentStart = -1;
            }
        }
    }

    if (depth > 0 && segmentStart >= 0) {
        out += input.slice(segmentStart + 1);
    }

    return out;
}

export function matchUtilityToBody(utility, body) {
    if (utility === body) {
        return { negative: "", value: "" };
    }

    if (utility.startsWith(`${body}-`)) {
        return { negative: "", value: utility.slice(body.length + 1) };
    }

    if (utility.startsWith(`-${body}-`)) {
        return { negative: "-", value: utility.slice(body.length + 2) };
    }

    return null;
}

export function getUtilityBodyCandidates(utility) {
    if (UTILITY_BODY_CANDIDATES_CACHE.has(utility)) {
        return UTILITY_BODY_CANDIDATES_CACHE.get(utility);
    }

    const normalized = utility.startsWith("-") ? utility.slice(1) : utility;
    const candidates = [];
    const seen = new Set();

    const pushCandidate = (value) => {
        if (value && !seen.has(value)) {
            seen.add(value);
            candidates.push(value);
        }
    };

    pushCandidate(normalized);

    for (let index = normalized.indexOf("-"); index >= 0; index = normalized.indexOf("-", index + 1)) {
        pushCandidate(normalized.slice(0, index));
    }

    UTILITY_BODY_CANDIDATES_CACHE.set(utility, candidates);
    return candidates;
}

export function isLikelyTailwindUtility(token) {
    if (!token || !token.utility) {
        return false;
    }

    // Strip arbitrary-value / theme-var bracket contents before the operator
    // gates, so a bracket-variant utility (e.g. `data-[state=open]:bg-red-500`,
    // `[&>svg]:size-4`) is not rejected by an `=`/`>`/`&` that only appears
    // INSIDE the brackets. This mirrors isLikelyFixUtility exactly, so the audit
    // path and the --fixall path agree on which tokens are Tailwind utilities,
    // otherwise --fixall would rewrite bracket-variant tokens the audit never
    // reported.
    if (
        TAILWIND_BAD_CHARS_RAW.test(stripBracketedSegments(token.raw)) ||
        TAILWIND_BAD_CHARS_UTIL.test(stripBracketedSegments(token.utility))
    ) {
        return false;
    }

    if (!token.utility.includes("-")) {
        return token.utility === "border";
    }

    return TAILWIND_UTIL_SHAPE.test(token.utility);
}

export function isLikelyFixUtility(raw) {
    if (!raw) {
        return false;
    }

    // Operator characters are only disqualifying when they appear OUTSIDE of
    // arbitrary-value brackets. Tokens like `data-[state=open]:bg-red-500`,
    // `[&>svg]:size-4`, or `border-(--color-x)/40` are all legitimate
    // Tailwind utilities and must not be filtered out here.
    const stripped = stripBracketedSegments(raw);
    if (/[=><&|?,'"`*]/.test(stripped)) {
        return false;
    }

    const token = parseFixToken(raw);
    if (!token.utility.includes("-")) {
        return token.utility === "border";
    }

    return /^-?[a-z][a-z0-9-]*(?:-[^\s]+)+$/.test(token.utility);
}

export const KNOWN_CANONICAL_UTILITY_REPLACEMENTS = new Map([
    ["break-words", "wrap-break-word"],
]);

export function getKnownCanonicalClass(raw) {
    if (!raw || typeof raw !== "string") {
        return null;
    }

    const token = parseFixToken(raw);
    const utility = KNOWN_CANONICAL_UTILITY_REPLACEMENTS.get(token.utility);
    if (!utility) {
        return null;
    }

    return buildFixToken({
        variants: token.variants,
        utility,
        important: token.important,
    });
}

export const TAILWIND_BAD_CHARS_RAW = /[=><&|?,'"`*]/;

export const TAILWIND_BAD_CHARS_UTIL = /[=><&|?*]/;

export const TAILWIND_UTIL_SHAPE = /^-?[a-z][a-z0-9-]*(?:-[^\s]+)+$/;

export const UTILITY_BODY_CANDIDATES_CACHE = new Map();

// Shared with the audit-side matchUtilityToBody (same function, no drift). It
// also matches the bare-body case (`utility === body`, value ""), which is
// only ever reached with a real bare-valid Tailwind body like `border`
// (`shorthand: 'all'` in the tailwind group data). mergeFixFamilyShorthand
// builds its target the way the audit's buildTarget does (no dash when the
// value is empty), and mergeFixWidthHeight only pairs compound `w-`/`h-`
// utilities, so the "" case never produces a dangling `-` suffix.
export const matchFixBodyValue = matchUtilityToBody;
