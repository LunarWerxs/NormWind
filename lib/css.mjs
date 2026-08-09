// CSS comparison primitives. `winningDeclarations` is the ground
// truth behind every merge-safety decision.

// Recursively inline local @import directives into the source CSS so
// Tailwind's design-system loader sees the project's @theme blocks even when
// they live in files imported from the entry CSS.
// Blank out comment bodies while preserving length, so a regex can run over
// the masked copy and its match indices still address the original text.
export function maskCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));
}

export function normalizeCssForCompare(css) {
    return String(css).replace(/\s+/g, " ").trim();
}

// Strip the outer selector (everything up to and including the first `{`)
// and the matching closing `}`, leaving only the rule body. Tailwind's
// `candidatesToCss` output for a single class always wraps the declarations
// in exactly one top-level rule.
export function extractCssRuleBody(css) {
    const text = String(css ?? "");
    const open = text.indexOf("{");
    if (open < 0) return "";
    const close = text.lastIndexOf("}");
    if (close <= open) return "";
    return normalizeCssForCompare(text.slice(open + 1, close));
}

// Compare two Tailwind-generated CSS rule strings (selectors ignored) under
// the assumption that the only allowed difference is: any `var(--themeKey)`
// reference in the candidate may be expanded to `var(--forwarded)` per the
// design system's @theme forwarder. This treats the candidate as
// runtime-equivalent because `--themeKey: var(--forwarded)` is a CSS custom-
// property forwarder that re-resolves at every use site.
export function cssRuleBodiesAreEquivalent(originalCss, candidateCss, themeKeyToForwarded) {
    const a = extractCssRuleBody(originalCss);
    const b = extractCssRuleBody(candidateCss);
    if (!a || !b) return false;
    if (a === b) return true;

    const substituted = b.replace(/var\(\s*(--[a-z0-9-]+)\s*([^)]*)\)/gi, (full, name, rest) => {
        const forwarded = themeKeyToForwarded.get(name);
        if (!forwarded) return full;
        return `var(${forwarded}${rest || ""})`;
    });
    return substituted === a;
}

// Collapsing a per-side set into a shorthand is the whole point of this tool,
// so the equivalence test cannot compare raw property names: `border-l-4
// border-r-4` emits border-left-width/border-right-width while `border-x-4`
// emits border-inline-width. Both resolve to the same computed style. Expand
// every shorthand and logical property this tool can produce down to a single
// canonical longhand set, then compare those.
//
// A value containing a space (a genuine multi-value shorthand) is left
// unexpanded, which can only make the comparison fail and the merge be
// refused. Tailwind's spacing/sizing utilities emit single values.
export const CSS_LONGHAND_EXPANSIONS = (() => {
    const map = new Map();
    const sides = ["top", "right", "bottom", "left"];

    const addBox = (prefix, suffix = "") => {
        const longhands = sides.map((side) => `${prefix}-${side}${suffix}`);
        map.set(`${prefix}${suffix}`, longhands);
        map.set(`${prefix}-inline${suffix}`, [`${prefix}-left${suffix}`, `${prefix}-right${suffix}`]);
        map.set(`${prefix}-block${suffix}`, [`${prefix}-top${suffix}`, `${prefix}-bottom${suffix}`]);
        map.set(`${prefix}-inline-start${suffix}`, [`${prefix}-left${suffix}`]);
        map.set(`${prefix}-inline-end${suffix}`, [`${prefix}-right${suffix}`]);
        map.set(`${prefix}-block-start${suffix}`, [`${prefix}-top${suffix}`]);
        map.set(`${prefix}-block-end${suffix}`, [`${prefix}-bottom${suffix}`]);
    };

    addBox("margin");
    addBox("padding");
    addBox("scroll-margin");
    addBox("scroll-padding");
    addBox("inset");
    addBox("border", "-width");
    addBox("border", "-style");
    addBox("border", "-color");

    map.set("border-radius", [
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-right-radius",
        "border-bottom-left-radius",
    ]);
    map.set("border-start-start-radius", ["border-top-left-radius"]);
    map.set("border-start-end-radius", ["border-top-right-radius"]);
    map.set("border-end-end-radius", ["border-bottom-right-radius"]);
    map.set("border-end-start-radius", ["border-bottom-left-radius"]);

    map.set("place-content", ["align-content", "justify-content"]);
    map.set("place-items", ["align-items", "justify-items"]);
    map.set("place-self", ["align-self", "justify-self"]);
    map.set("gap", ["row-gap", "column-gap"]);
    map.set("overflow", ["overflow-x", "overflow-y"]);
    map.set("overscroll-behavior", ["overscroll-behavior-x", "overscroll-behavior-y"]);

    return map;
})();

// True when the value is ONE CSS value rather than a shorthand's multi-value
// list. Depth-aware, because `calc(var(--spacing) * 4)` is a single value that
// happens to contain spaces: a naive `includes(" ")` test disqualified every
// spacing and sizing utility Tailwind emits, which silently turned the whole
// expansion below into a no-op.
export function isSingleCssValue(value) {
    let depth = 0;
    let sawGap = false;
    let sawTokenAfterGap = false;
    let sawToken = false;
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (ch === "(" || ch === "[") {
            depth += 1;
        } else if (ch === ")" || ch === "]") {
            depth -= 1;
        }
        if (depth > 0) {
            sawToken = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (sawToken) {
                sawGap = true;
            }
            continue;
        }
        sawToken = true;
        if (sawGap) {
            sawTokenAfterGap = true;
        }
    }
    return !sawTokenAfterGap;
}

export function recordDeclaration(declarations, property, value) {
    const longhands = isSingleCssValue(value) ? CSS_LONGHAND_EXPANSIONS.get(property) : null;
    if (!longhands) {
        declarations.set(property, value);
        return;
    }
    for (const longhand of longhands) {
        declarations.set(longhand, value);
    }
}

// Last-writer-wins declaration map for a class list, resolved in Tailwind's
// own emit order. Returns null when the engine cannot answer.
export function winningDeclarations(designSystem, classList) {
    let order;
    try {
        order = designSystem.getClassOrder(classList);
    } catch {
        return null;
    }
    if (!Array.isArray(order)) {
        return null;
    }

    const ranked = order
        .filter((entry) => Array.isArray(entry) && entry[1] !== null && entry[1] !== undefined)
        .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        .map((entry) => entry[0]);

    const declarations = new Map();
    for (const className of ranked) {
        let css;
        try {
            css = designSystem.candidatesToCss([className])?.[0];
        } catch {
            return null;
        }
        if (!css) {
            continue;
        }
        for (const match of String(css).matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)) {
            recordDeclaration(declarations, match[1].trim(), match[2].trim());
        }
    }
    return declarations;
}
