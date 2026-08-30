// Where a class string may legally appear in a source file.
//
// Extraction is anchored to class-bearing attributes and to the argument lists
// of known class-string builders, so something has to decide which positions
// qualify: a Babel pass over JS/TS/JSX that resolves render-function and
// builder aliases, and a tolerant structural pass over markup formats for the
// parts Babel cannot see. The answer is a set of allowed start offsets, cached
// per source text; class-extraction.mjs turns those offsets into strings.

import path from "node:path";
import * as bundledBabelParser from "@babel/parser";
import { findRawElementClose, parseMarkupTag, splitTemplateStaticChunks } from "./text.mjs";
import { getKnownCanonicalClass, stripBracketedSegments } from "./tokens.mjs";
import { MARKUP_EXTENSIONS } from "./scan-config.mjs";

const QUOTE_VALUE_SHAPE = /\b(?:[a-z]+:)*!?-?[a-z][a-z0-9-]*(?:-[^\s]+)*!?\b/i;

function shouldExtractQuotedClassValue(value, { allowSingleTokenCanonical = false } = {}) {
    const singleToken = !value.includes(" ");
    if (
        singleToken &&
        !(
            (allowSingleTokenCanonical && (
                value.includes("[") ||
                value.includes("(--") ||
                getKnownCanonicalClass(value)
            )) ||
            value.startsWith("!") ||
            value.includes(":!")
        )
    ) {
        return false;
    }

    if (!value.includes("-") && !value.includes("!")) {
        return false;
    }

    // Operator characters only disqualify when they appear OUTSIDE Tailwind's
    // arbitrary-value brackets/parens: `data-[state=open]:x` is a plain
    // class string. This mirrors looksLikeFixableClassString exactly: the
    // audit and fix paths must agree on what counts as a class string, or
    // "audit clean" stops implying "fix is a no-op".
    if (/[=><&|?*]/.test(stripBracketedSegments(value))) {
        return false;
    }

    return QUOTE_VALUE_SHAPE.test(value);
}


const NESTED_QUOTE_REGEXES = {
    '"': /"((?:\\.|[^"\\])*)"/g,
    "'": /'((?:\\.|[^'\\])*)'/g,
    "`": /`((?:\\.|[^`\\])*)`/g,
};

function extractNestedQuotedClassStrings(value, baseIndex, options, quoteKinds = ["'", "`"]) {
    const results = [];

    for (const kind of quoteKinds) {
        const quoteRegex = NESTED_QUOTE_REGEXES[kind];
        quoteRegex.lastIndex = 0;
        let match;
        while ((match = quoteRegex.exec(value)) !== null) {
            const quotedValue = match[1];
            const quotedStart = baseIndex + match.index + 1;

            if (kind === "`" && quotedValue.includes("${")) {
                for (const chunk of splitTemplateStaticChunks(quotedValue)) {
                    if (shouldExtractQuotedClassValue(chunk.text, options)) {
                        results.push({
                            value: chunk.text,
                            index: quotedStart + chunk.offset,
                        });
                    }
                }
                continue;
            }

            if (!shouldExtractQuotedClassValue(quotedValue, options)) {
                continue;
            }

            results.push({
                value: quotedValue,
                index: quotedStart,
            });
        }
    }

    return results;
}

// The attribute names that carry a class list, in every framework dialect the
// markup pass understands.
const CLASS_ATTRIBUTE_NAMES = new Set(["class", "className", ":class", "v-bind:class"]);

const RENDER_FUNCTION_NAMES = new Set([
    "h",
    "createElement",
    "createVNode",
    "createElementVNode",
    "createBlock",
    "createElementBlock",
    "cloneVNode",
    "jsx",
    "jsxs",
    "jsxDEV",
    "_jsx",
    "_jsxs",
    "_jsxDEV",
]);
// Class-string builders. Unlike the render functions above, EVERY string
// argument these receive is a class list, including strings nested in the
// variant objects of cva()/tv(). This is where a large share of modern
// Tailwind lives (shadcn/ui, class-variance-authority, tailwind-variants),
// and it used to be completely invisible to the scanner.
const CLASS_STRING_FUNCTION_NAMES = new Set([
    "classNames",
    "classnames",
    "clsx",
    "cn",
    "cva",
    "cx",
    "tv",
    "twJoin",
    "twMerge",
]);
// Depth cap for walking a cva()/tv() config object. Real configs nest three
// or four levels; the cap only stops a pathological input from recursing.
const MAX_CLASS_ARGUMENT_DEPTH = 8;


function getBabelParser() {
    return bundledBabelParser;
}

function unwrapExpression(node) {
    let current = node;
    const wrapperTypes = new Set([
        "ChainExpression",
        "ParenthesizedExpression",
        "TSAsExpression",
        "TSInstantiationExpression",
        "TSNonNullExpression",
        "TSSatisfiesExpression",
        "TSTypeAssertion",
        "TypeCastExpression",
    ]);
    while (current && wrapperTypes.has(current.type)) {
        current = current.expression;
    }
    return current;
}

function getCalledFunctionName(callee) {
    const unwrapped = unwrapExpression(callee);
    if (unwrapped?.type === "Identifier") {
        return unwrapped.name;
    }
    if (unwrapped?.type === "MemberExpression" || unwrapped?.type === "OptionalMemberExpression") {
        if (!unwrapped.computed && unwrapped.property?.type === "Identifier") {
            return unwrapped.property.name;
        }
        if (unwrapped.computed && unwrapped.property?.type === "StringLiteral") {
            return unwrapped.property.value;
        }
    }
    return null;
}

function getObjectPropertyName(property) {
    if (property?.type !== "ObjectProperty" || property.computed) {
        return null;
    }
    if (property.key?.type === "Identifier") {
        return property.key.name;
    }
    if (property.key?.type === "StringLiteral") {
        return property.key.value;
    }
    return null;
}

// Classify one AST node during analyzeBabelAst's stack walk: record class
// attributes, import/local-var alias pairs, and call expressions. Split out
// so the walk's if/else chain isn't counted against the outer function too.
function classifyAstNode(node, offset, { allowedAttributeStarts, aliasPairs, callNodes }) {
    if (node.type === "JSXAttribute") {
        const name = node.name?.type === "JSXIdentifier" ? node.name.name : null;
        if ((name === "class" || name === "className") && Number.isInteger(node.start)) {
            allowedAttributeStarts.add(offset + node.start);
        }
    } else if (node.type === "ImportSpecifier") {
        const imported = node.imported?.name ?? node.imported?.value;
        const local = node.local?.name;
        if (typeof imported === "string" && typeof local === "string") {
            aliasPairs.push([local, imported]);
        }
    } else if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
        const sourceName = getCalledFunctionName(node.init);
        if (sourceName) {
            aliasPairs.push([node.id.name, sourceName]);
        }
    } else if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
        callNodes.push(node);
    }
}

// Push one AST node's traversable children onto the walk stack, skipping the
// metadata keys Babel attaches to every node. Split out of analyzeBabelAst.
function pushChildNodes(node, stack) {
    for (const [key, value] of Object.entries(node)) {
        if (
            key === "loc"
            || key === "errors"
            || key === "comments"
            || key === "tokens"
            || key === "extra"
        ) {
            continue;
        }
        if (Array.isArray(value)) {
            for (let i = value.length - 1; i >= 0; i -= 1) {
                if (value[i] && typeof value[i] === "object") {
                    stack.push(value[i]);
                }
            }
        } else if (value && typeof value === "object") {
            stack.push(value);
        }
    }
}

// Resolve imported/local aliases to a fixed point after traversal, so source
// order and the iterative stack order cannot affect whether a render call is
// recognized. Split out of analyzeBabelAst.
function resolveFunctionAliases(aliasPairs, renderFunctionNames, classStringFunctionNames) {
    let addedAlias = true;
    while (addedAlias) {
        addedAlias = false;
        for (const [local, source] of aliasPairs) {
            if (renderFunctionNames.has(source) && !renderFunctionNames.has(local)) {
                renderFunctionNames.add(local);
                addedAlias = true;
            }
            if (classStringFunctionNames.has(source) && !classStringFunctionNames.has(local)) {
                classStringFunctionNames.add(local);
                addedAlias = true;
            }
        }
    }
}

// Feed every class-string-builder call's arguments through collectArgs. Split
// out of analyzeBabelAst's two callNodes passes.
function collectClassStringSpansFromCalls(callNodes, classStringFunctionNames, collectArgs) {
    for (const call of callNodes) {
        const calleeName = getCalledFunctionName(call.callee);
        if (!calleeName || !classStringFunctionNames.has(calleeName)) {
            continue;
        }
        for (const argument of call.arguments) {
            collectArgs(argument, 0);
        }
    }
}

// Record class/className object-property starts passed as props to a
// recognized render call. Split out of analyzeBabelAst's two callNodes passes.
function collectAllowedObjectPropertyStarts(callNodes, renderFunctionNames, offset, allowedObjectPropertyStarts) {
    for (const call of callNodes) {
        const calleeName = getCalledFunctionName(call.callee);
        if (!calleeName || !renderFunctionNames.has(calleeName)) {
            continue;
        }

        // In React/Vue/Preact-style render APIs, the first argument is the
        // element/component and subsequent direct object arguments are props.
        for (const argument of call.arguments.slice(1)) {
            const props = unwrapExpression(argument);
            if (props?.type !== "ObjectExpression") {
                continue;
            }
            for (const property of props.properties) {
                const propertyName = getObjectPropertyName(property);
                if (
                    (propertyName === "class" || propertyName === "className")
                    && Number.isInteger(property.key?.start)
                ) {
                    allowedObjectPropertyStarts.add(offset + property.key.start);
                }
            }
        }
    }
}

function analyzeBabelAst(ast, offset = 0) {
    const allowedAttributeStarts = new Set();
    const allowedObjectPropertyStarts = new Set();
    const classStringSpans = [];
    const renderFunctionNames = new Set(RENDER_FUNCTION_NAMES);
    const classStringFunctionNames = new Set(CLASS_STRING_FUNCTION_NAMES);
    const aliasPairs = [];
    const callNodes = [];
    const stack = [ast];

    while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== "object") {
            continue;
        }

        classifyAstNode(node, offset, { allowedAttributeStarts, aliasPairs, callNodes });
        pushChildNodes(node, stack);
    }

    // Resolve imported/local aliases after traversal so source order and the
    // iterative stack order cannot affect whether a render call is recognized.
    resolveFunctionAliases(aliasPairs, renderFunctionNames, classStringFunctionNames);

    // Record the inner bounds of every string that a class-string builder
    // receives, following the shapes those APIs actually use: bare strings,
    // arrays, ternaries, `cond && "..."`, and the nested objects of a cva()
    // variant map. Values that are not class lists (variant keys such as
    // "lg") are filtered later by shouldExtractQuotedClassValue.
    const collectClassStringArguments = (node, depth) => {
        if (depth > MAX_CLASS_ARGUMENT_DEPTH) {
            return;
        }
        const unwrapped = unwrapExpression(node);
        if (!unwrapped || typeof unwrapped !== "object") {
            return;
        }

        if (unwrapped.type === "StringLiteral" && Number.isInteger(unwrapped.start)) {
            classStringSpans.push({
                start: offset + unwrapped.start + 1,
                end: offset + unwrapped.end - 1,
            });
            return;
        }
        if (unwrapped.type === "TemplateLiteral") {
            // Only a template with no interpolation is a literal class list;
            // splitTemplateStaticChunks already handles the interpolated form
            // wherever a class attribute contains one.
            if (unwrapped.expressions.length === 0 && unwrapped.quasis.length === 1) {
                const quasi = unwrapped.quasis[0];
                classStringSpans.push({ start: offset + quasi.start, end: offset + quasi.end });
            }
            return;
        }
        if (unwrapped.type === "ArrayExpression") {
            for (const element of unwrapped.elements) {
                collectClassStringArguments(element, depth + 1);
            }
            return;
        }
        if (unwrapped.type === "ObjectExpression") {
            for (const property of unwrapped.properties) {
                if (property?.type === "ObjectProperty") {
                    collectClassStringArguments(property.value, depth + 1);
                }
            }
            return;
        }
        if (unwrapped.type === "ConditionalExpression") {
            collectClassStringArguments(unwrapped.consequent, depth + 1);
            collectClassStringArguments(unwrapped.alternate, depth + 1);
            return;
        }
        if (unwrapped.type === "LogicalExpression") {
            collectClassStringArguments(unwrapped.right, depth + 1);
        }
    };

    collectClassStringSpansFromCalls(callNodes, classStringFunctionNames, collectClassStringArguments);
    collectAllowedObjectPropertyStarts(callNodes, renderFunctionNames, offset, allowedObjectPropertyStarts);

    return { allowedAttributeStarts, allowedObjectPropertyStarts, classStringSpans };
}

function parserPluginVariants({ typescript, jsx }) {
    const syntaxVariants = typescript
        ? [["typescript"]]
        : [[], ["flow"]];
    const decoratorVariants = [
        ["decorators-legacy"],
        [["decorators", { decoratorsBeforeExport: true }]],
    ];
    const variants = [];

    for (const syntaxPlugins of syntaxVariants) {
        for (const decoratorPlugins of decoratorVariants) {
            variants.push([
                ...syntaxPlugins,
                ...(jsx ? ["jsx"] : []),
                ...decoratorPlugins,
                "explicitResourceManagement",
                "importAttributes",
            ]);
        }
    }
    return variants;
}

function parseAndAnalyzeJavaScript(
    sourceText,
    filePath,
    { typescript = false, jsx = false, offset = 0 } = {},
) {
    const { parse } = getBabelParser();
    let lastError = null;

    for (const plugins of parserPluginVariants({ typescript, jsx })) {
        try {
            const ast = parse(sourceText, {
                sourceType: "unambiguous",
                sourceFilename: filePath,
                plugins,
                errorRecovery: true,
                attachComment: false,
                allowAwaitOutsideFunction: true,
                allowImportExportEverywhere: true,
                allowNewTargetOutsideFunction: true,
                allowReturnOutsideFunction: true,
                allowSuperOutsideMethod: true,
                allowUndeclaredExports: true,
            });
            if (ast.errors?.length > 0) {
                lastError = ast.errors[0];
                continue;
            }
            return analyzeBabelAst(ast, offset);
        } catch (error) {
            lastError = error;
        }
    }

    const detail = lastError?.message ?? "unknown parser error";
    throw new Error(`could not safely parse ${filePath}: ${detail}`);
}




// `requireTemplate` is the Vue SFC rule: class attributes only count inside a
// <template>. Svelte, Astro and plain HTML have no such wrapper, so their
// markup is scanned at top level instead, with <script>/<style> bodies still
// skipped as raw regions.
// Advance past a `{{ ... }}` interpolation (or to EOF if unterminated).
// Split out of analyzeMarkupStructure.
function skipInterpolation(sourceText, interpolationStart) {
    const interpolationEnd = sourceText.indexOf("}}", interpolationStart + 2);
    return interpolationEnd === -1 ? sourceText.length : interpolationEnd + 2;
}

// Advance past an HTML comment (or to EOF if unterminated). Split out of
// analyzeMarkupStructure.
function skipHtmlComment(sourceText, commentStart) {
    const commentEnd = sourceText.indexOf("-->", commentStart + 4);
    return commentEnd === -1 ? sourceText.length : commentEnd + 3;
}

// Record every class-attribute start on an open tag inside an active
// template region. Split out of analyzeMarkupStructure.
function collectClassAttributeStarts(tag, allowedAttributeStarts) {
    for (const attribute of tag.attributes) {
        if (CLASS_ATTRIBUTE_NAMES.has(attribute.name)) {
            allowedAttributeStarts.add(attribute.start);
        }
    }
}

// Handle a <script>/<style> open tag: locate its raw-text close, and for
// <script> record the block for later JS/TS analysis. Returns the cursor to
// resume scanning from. Split out of analyzeMarkupStructure.
function consumeRawElement(sourceText, tag, lowerName, scriptBlocks) {
    const close = findRawElementClose(sourceText, lowerName, tag.end + 1);
    if (!close) {
        return sourceText.length;
    }
    if (lowerName === "script") {
        const langAttribute = tag.attributes.find(
            (attribute) => attribute.name.toLowerCase() === "lang",
        );
        const typeAttribute = tag.attributes.find(
            (attribute) => attribute.name.toLowerCase() === "type",
        );
        // Svelte/Astro spell it `lang="ts"`; plain HTML uses
        // type="module" or nothing at all.
        const lang = langAttribute?.value?.toLowerCase()
            ?? (typeAttribute?.value?.toLowerCase() === "module" ? "js" : null)
            ?? "js";
        scriptBlocks.push({
            source: sourceText.slice(tag.end + 1, close.start),
            offset: tag.end + 1,
            lang,
        });
    }
    return close.end;
}

// Skip an unknown top-level SFC custom block's raw contents, so embedded
// markup/data cannot be mistaken for renderable class attributes. Split out
// of analyzeMarkupStructure.
function skipUnknownBlock(sourceText, tag, lowerName) {
    const close = findRawElementClose(sourceText, lowerName, tag.end + 1);
    return close ? close.end : tag.end + 1;
}

// Compute the template-nesting depth after consuming a closing tag. Split
// out of analyzeMarkupStructure so the nested if inside its `tag.closing`
// branch isn't counted against the outer function too.
function closingTemplateDepth(lowerName, requireTemplate, templateDepth) {
    if (requireTemplate && lowerName === "template" && templateDepth > 0) {
        return templateDepth - 1;
    }
    return templateDepth;
}

function analyzeMarkupStructure(sourceText, { requireTemplate = true } = {}) {
    const allowedAttributeStarts = new Set();
    const scriptBlocks = [];
    let templateDepth = requireTemplate ? 0 : 1;
    let cursor = 0;

    while (cursor < sourceText.length) {
        const nextTag = sourceText.indexOf("<", cursor);
        const nextInterpolation = templateDepth > 0
            ? sourceText.indexOf("{{", cursor)
            : -1;

        if (
            nextInterpolation !== -1
            && (nextTag === -1 || nextInterpolation < nextTag)
        ) {
            cursor = skipInterpolation(sourceText, nextInterpolation);
            continue;
        }
        if (nextTag === -1) {
            break;
        }
        if (sourceText.startsWith("<!--", nextTag)) {
            cursor = skipHtmlComment(sourceText, nextTag);
            continue;
        }

        const tag = parseMarkupTag(sourceText, nextTag);
        if (!tag) {
            break;
        }
        const lowerName = tag.name.toLowerCase();

        if (tag.closing) {
            templateDepth = closingTemplateDepth(lowerName, requireTemplate, templateDepth);
            cursor = tag.end + 1;
            continue;
        }

        if (templateDepth > 0 && !(requireTemplate && lowerName === "template")) {
            collectClassAttributeStarts(tag, allowedAttributeStarts);
        }

        if (requireTemplate && lowerName === "template" && !tag.selfClosing) {
            templateDepth += 1;
            cursor = tag.end + 1;
            continue;
        }

        if (lowerName === "script" || lowerName === "style") {
            cursor = consumeRawElement(sourceText, tag, lowerName, scriptBlocks);
            continue;
        }

        // Unknown top-level SFC custom blocks are not Vue templates. Skip
        // their raw contents so embedded markup/data cannot be mistaken for
        // renderable class attributes.
        if (requireTemplate && templateDepth === 0 && lowerName && !tag.selfClosing) {
            cursor = skipUnknownBlock(sourceText, tag, lowerName);
            continue;
        }

        cursor = tag.end + 1;
    }

    return { allowedAttributeStarts, scriptBlocks };
}

function mergeSyntaxAnalysis(target, source) {
    for (const start of source.allowedAttributeStarts) {
        target.allowedAttributeStarts.add(start);
    }
    for (const start of source.allowedObjectPropertyStarts) {
        target.allowedObjectPropertyStarts.add(start);
    }
    for (const span of source.classStringSpans ?? []) {
        target.classStringSpans.push(span);
    }
}

// The structural Babel/Vue analysis is the single most expensive step per
// file, and the fix path used to redo it for the very same text: once in
// collectBracketFixCandidates and again on the first applyFixesToText pass.
// Cache the last analysis per file path and reuse it whenever the text is
// byte-identical. Offsets shift as soon as a rewrite lands, so a changed pass
// still re-analyzes; this only removes the provably redundant repeats.
const SYNTAX_ANALYSIS_CACHE = new Map();
const MAX_SYNTAX_ANALYSIS_CACHE_ENTRIES = 64;

function analyzeClassSyntaxCached(sourceText, filePath) {
    const key = filePath ?? "";
    const cached = SYNTAX_ANALYSIS_CACHE.get(key);
    if (cached && cached.sourceText === sourceText) {
        return cached.analysis;
    }

    const analysis = analyzeClassSyntax(sourceText, filePath);
    if (SYNTAX_ANALYSIS_CACHE.size >= MAX_SYNTAX_ANALYSIS_CACHE_ENTRIES) {
        // Plain FIFO eviction; the access pattern is "same file several times
        // in a row", so recency beyond one entry per path buys nothing.
        SYNTAX_ANALYSIS_CACHE.delete(SYNTAX_ANALYSIS_CACHE.keys().next().value);
    }
    SYNTAX_ANALYSIS_CACHE.set(key, { sourceText, analysis });
    return analysis;
}

function analyzeClassSyntax(sourceText, filePath) {
    const analysis = {
        allowedAttributeStarts: new Set(),
        allowedObjectPropertyStarts: new Set(),
        classStringSpans: [],
    };
    const normalizedPath = String(filePath ?? "source.js").toLowerCase();
    const extension = path.extname(normalizedPath);

    if (MARKUP_EXTENSIONS.has(extension)) {
        // Astro frontmatter is a leading `---` fenced TypeScript block. It is
        // not markup, so hand it to the JS analyzer and scan only what follows
        // as markup.
        let markupSource = sourceText;
        let markupOffset = 0;
        if (extension === ".astro") {
            const frontmatter = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(sourceText);
            if (frontmatter) {
                markupOffset = frontmatter[0].length;
                markupSource = " ".repeat(markupOffset) + sourceText.slice(markupOffset);
            }
        }

        const markup = analyzeMarkupStructure(markupSource, {
            requireTemplate: extension === ".vue",
        });
        for (const start of markup.allowedAttributeStarts) {
            analysis.allowedAttributeStarts.add(start);
        }
        for (const block of markup.scriptBlocks) {
            const isTypeScript = ["ts", "tsx", "mts", "cts"].includes(block.lang);
            const isJavaScript = ["js", "jsx", "mjs", "cjs", "babel"].includes(block.lang);
            if (!isTypeScript && !isJavaScript) {
                continue;
            }
            let scriptAnalysis;
            try {
                scriptAnalysis = parseAndAnalyzeJavaScript(
                    block.source,
                    `${filePath ?? "source"}?script=${block.lang}`,
                    {
                        typescript: isTypeScript,
                        jsx: block.lang === "tsx" || block.lang === "jsx" || isJavaScript,
                        offset: block.offset,
                    },
                );
            } catch (error) {
                // Svelte and Astro scripts use framework-specific syntax
                // (`$:` labels are valid JS, but `{#if}` blocks in Astro's
                // frontmatter are not). A script we cannot parse means no
                // render-function props are recognized in it; the markup
                // attributes above are still perfectly usable, so degrade
                // rather than failing the whole file. Vue SFCs keep the strict
                // behavior because their script block is plain JS/TS.
                if (extension === ".vue") {
                    throw error;
                }
                continue;
            }
            mergeSyntaxAnalysis(analysis, scriptAnalysis);
        }
        return analysis;
    }

    const isTypeScript = extension === ".ts" || extension === ".tsx"
        || extension === ".mts" || extension === ".cts";
    return parseAndAnalyzeJavaScript(sourceText, filePath ?? "source.js", {
        typescript: isTypeScript,
        jsx: extension === ".jsx" || extension === ".tsx" || !isTypeScript,
    });
}

export { analyzeClassSyntaxCached, extractNestedQuotedClassStrings, shouldExtractQuotedClassValue };
