// ---------------------------------------------------------------------------
// Class-string extraction, shared by the audit and fix paths.
//
// Extraction is anchored to class-bearing attributes: `class`, `className`,
// `:class`, and `v-bind:class` (quoted or JSX-brace values), plus quoted
// strings nested inside those values (ternaries, object bindings). Blanket
// scanning of every quoted string in the file (the pre-3.4 behavior) is
// gone: it rewrote unrelated code whose strings merely looked like utility
// lists (SQL fragments, title attributes, debug labels).
//
// Both paths sharing one extractor is a correctness contract: if the audit
// reports clean, the fixer must be a no-op on the same file.
// ---------------------------------------------------------------------------

import { findBalancedBraceEnd, splitTemplateStaticChunks } from "./text.mjs";
import {
    analyzeClassSyntaxCached,
    extractNestedQuotedClassStrings,
    shouldExtractQuotedClassValue,
} from "./class-syntax.mjs";

// The lookbehind refuses a preceding [\w-] so attribute names that merely end
// in "class" (data-class, my-class, aria-class) never match.
const CLASS_ATTR_VALUE_REGEX = /(?<![\w-])(?:v-bind:class|className|:class|class)\s*=\s*(["'])([\s\S]*?)\1/g;
const CLASS_ATTR_BRACE_REGEX = /(?<![\w-])(?:className|class)\s*=\s*\{/g;
// Object-property form: `{ class: '...' }` / `{ className: "..." }` as used
// by createElement/hyperscript/render-function calls. Syntax analysis below
// limits these matches to props objects passed to known render functions.
const CLASS_OBJECT_KEY_REGEX = /(?<![\w-])(?:className|class)\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;


// Cheap pre-filter mirroring CLASS_STRING_FUNCTION_NAMES, so a file with no
// class attribute and no builder call skips parsing entirely.
const CLASS_BUILDER_HINT = /\b(?:clsx|cva|cx|cn|tv|twMerge|twJoin|classNames|classnames)\s*\(/;



// Scan class="..."/class='...' attribute values (plus their nested quoted
// strings). Split out of extractClassLikeStrings's four scanning passes.
function collectClassAttrValueMatches(sourceText, allowedAttributeStarts, allowSingleTokenCanonical, push) {
    CLASS_ATTR_VALUE_REGEX.lastIndex = 0;
    let match;
    while ((match = CLASS_ATTR_VALUE_REGEX.exec(sourceText)) !== null) {
        if (!allowedAttributeStarts.has(match.index)) {
            continue;
        }
        const value = match[2];
        // The value sits immediately before the closing quote, so compute its
        // start positionally, because indexOf would hit an earlier occurrence for
        // values like class="class".
        const startIndex = match.index + match[0].length - 1 - value.length;
        push(value, startIndex);

        const nestedKinds = match[1] === '"' ? ["'", "`"] : ['"', "`"];
        for (const nested of extractNestedQuotedClassStrings(
            value,
            startIndex,
            { allowSingleTokenCanonical },
            nestedKinds,
        )) {
            push(nested.value, nested.index);
        }
    }
}

// Scan class={ ... } brace-expression attribute values. Split out of
// extractClassLikeStrings's four scanning passes.
function collectClassAttrBraceMatches(sourceText, allowedAttributeStarts, allowSingleTokenCanonical, push) {
    CLASS_ATTR_BRACE_REGEX.lastIndex = 0;
    let match;
    while ((match = CLASS_ATTR_BRACE_REGEX.exec(sourceText)) !== null) {
        if (!allowedAttributeStarts.has(match.index)) {
            continue;
        }
        const openIndex = match.index + match[0].length - 1;
        const closeIndex = findBalancedBraceEnd(sourceText, openIndex);
        if (closeIndex === -1) {
            continue;
        }

        const body = sourceText.slice(openIndex + 1, closeIndex);
        for (const nested of extractNestedQuotedClassStrings(
            body,
            openIndex + 1,
            { allowSingleTokenCanonical },
            ['"', "'", "`"],
        )) {
            push(nested.value, nested.index);
        }
        CLASS_ATTR_BRACE_REGEX.lastIndex = closeIndex + 1;
    }
}

// Scan `class`/`className` object-property values. Split out of
// extractClassLikeStrings's four scanning passes.
function collectClassObjectKeyMatches(sourceText, allowedObjectPropertyStarts, allowSingleTokenCanonical, push) {
    CLASS_OBJECT_KEY_REGEX.lastIndex = 0;
    let match;
    while ((match = CLASS_OBJECT_KEY_REGEX.exec(sourceText)) !== null) {
        if (!allowedObjectPropertyStarts.has(match.index)) {
            continue;
        }
        const value = match[2];
        const startIndex = match.index + match[0].length - 1 - value.length;

        if (match[1] === "`" && value.includes("${")) {
            for (const chunk of splitTemplateStaticChunks(value)) {
                if (shouldExtractQuotedClassValue(chunk.text, { allowSingleTokenCanonical })) {
                    push(chunk.text, startIndex + chunk.offset);
                }
            }
            continue;
        }

        if (shouldExtractQuotedClassValue(value, { allowSingleTokenCanonical })) {
            push(value, startIndex);
        }
    }
}

// Emit the class-string-builder spans analyzeClassSyntax already located.
// Split out of extractClassLikeStrings's four scanning passes.
function collectClassStringSpanMatches(sourceText, classStringSpans, allowSingleTokenCanonical, push) {
    for (const span of classStringSpans ?? []) {
        if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.end <= span.start) {
            continue;
        }
        const value = sourceText.slice(span.start, span.end);
        if (shouldExtractQuotedClassValue(value, { allowSingleTokenCanonical })) {
            push(value, span.start);
        }
    }
}

function extractClassLikeStrings(
    sourceText,
    { allowSingleTokenCanonical = false, filePath = null } = {},
) {
    // A class-string builder call (clsx/cva/tv/cn) does not have to contain the
    // substring "class", so the cheap bail-out has to look for those too.
    if (!sourceText.includes("class") && !CLASS_BUILDER_HINT.test(sourceText)) {
        return [];
    }
    const {
        allowedAttributeStarts,
        allowedObjectPropertyStarts,
        classStringSpans,
    } = analyzeClassSyntaxCached(sourceText, filePath);
    const results = [];
    const seen = new Set();
    const push = (value, index) => {
        const key = `${index}:${value.length}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        results.push({ value, index });
    };

    collectClassAttrValueMatches(sourceText, allowedAttributeStarts, allowSingleTokenCanonical, push);
    collectClassAttrBraceMatches(sourceText, allowedAttributeStarts, allowSingleTokenCanonical, push);
    collectClassObjectKeyMatches(sourceText, allowedObjectPropertyStarts, allowSingleTokenCanonical, push);
    collectClassStringSpanMatches(sourceText, classStringSpans, allowSingleTokenCanonical, push);

    results.sort((a, b) => a.index - b.index);
    return results;
}

export { extractClassLikeStrings };
