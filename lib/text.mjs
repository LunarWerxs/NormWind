// Source-position and bracket-scanning helpers shared by the
// extractors. Pure string work.

export function buildLineStarts(text) {
    const starts = [0];
    let idx = text.indexOf("\n");
    while (idx !== -1) {
        starts.push(idx + 1);
        idx = text.indexOf("\n", idx + 1);
    }
    return starts;
}

export function indexToLineCol(lineStarts, index) {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineStarts[mid] <= index) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const lineIndex = Math.max(0, high);
    return {
        line: lineIndex + 1,
        column: index - lineStarts[lineIndex] + 1,
    };
}

// Split a template-literal body into its static text chunks around `${...}`
// interpolations, so an operator inside an interpolation cannot disqualify
// (or expose to rewriting) the static class tokens around it. Chunks that
// butt directly against an interpolation get their partial edge token
// trimmed: `h-${size}` must never surface a bare `h-` token.
export function splitTemplateStaticChunks(content) {
    const chunks = [];
    let chunkStart = 0;
    let i = 0;

    const pushChunk = (start, end, openEdge, closeEdge) => {
        let s = start;
        let e = end;
        if (openEdge && s < e && !/\s/.test(content[s])) {
            const ws = content.slice(s, e).search(/\s/);
            if (ws === -1) {
                return;
            }
            s += ws;
        }
        if (closeEdge && s < e && !/\s/.test(content[e - 1])) {
            const trimmed = content.slice(s, e).replace(/\S+$/, "");
            e = s + trimmed.length;
        }
        if (s < e) {
            chunks.push({ text: content.slice(s, e), offset: s });
        }
    };

    while (i < content.length) {
        if (content[i] === "\\") {
            i += 2;
            continue;
        }
        if (content[i] === "$" && content[i + 1] === "{") {
            pushChunk(chunkStart, i, chunkStart > 0, true);
            // Skip the interpolation body (depth-aware, quote-aware).
            let depth = 0;
            let quote = null;
            let j = i + 1;
            for (; j < content.length; j += 1) {
                const ch = content[j];
                if (quote) {
                    if (ch === "\\") {
                        j += 1;
                    } else if (ch === quote) {
                        quote = null;
                    }
                    continue;
                }
                if (ch === '"' || ch === "'" || ch === "`") {
                    quote = ch;
                } else if (ch === "{") {
                    depth += 1;
                } else if (ch === "}") {
                    depth -= 1;
                    if (depth === 0) {
                        break;
                    }
                }
            }
            i = j + 1;
            chunkStart = i;
            continue;
        }
        i += 1;
    }

    pushChunk(chunkStart, content.length, chunkStart > 0, false);
    return chunks;
}

// Find the index of the `}` matching the `{` at openIndex, respecting quoted
// strings inside the expression. Returns -1 when unbalanced.
export function findBalancedBraceEnd(text, openIndex) {
    let depth = 0;
    let quote = null;
    for (let i = openIndex; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (ch === "\\") {
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "{") {
            depth += 1;
        } else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

export function findMarkupTagEnd(sourceText, openIndex) {
    let quote = null;
    for (let i = openIndex + 1; i < sourceText.length; i += 1) {
        const ch = sourceText[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === ">") {
            return i;
        }
    }
    return -1;
}

export function parseMarkupTag(sourceText, openIndex) {
    const end = findMarkupTagEnd(sourceText, openIndex);
    if (end === -1) {
        return null;
    }

    let cursor = openIndex + 1;
    while (cursor < end && /\s/.test(sourceText[cursor])) {
        cursor += 1;
    }
    const closing = sourceText[cursor] === "/";
    if (closing) {
        cursor += 1;
        while (cursor < end && /\s/.test(sourceText[cursor])) {
            cursor += 1;
        }
    }
    const nameStart = cursor;
    while (cursor < end && !/[\s/>]/.test(sourceText[cursor])) {
        cursor += 1;
    }
    const name = sourceText.slice(nameStart, cursor);
    if (!name || name.startsWith("!") || name.startsWith("?")) {
        return { end, closing, name: "", selfClosing: false, attributes: [] };
    }
    if (closing) {
        return {
            end,
            closing: true,
            name,
            selfClosing: false,
            attributes: [],
        };
    }

    const attributes = [];
    while (cursor < end) {
        while (cursor < end && /\s/.test(sourceText[cursor])) {
            cursor += 1;
        }
        if (cursor >= end || sourceText[cursor] === "/") {
            break;
        }

        const start = cursor;
        while (cursor < end && !/[\s=/>]/.test(sourceText[cursor])) {
            cursor += 1;
        }
        const attributeName = sourceText.slice(start, cursor);
        while (cursor < end && /\s/.test(sourceText[cursor])) {
            cursor += 1;
        }

        let value = null;
        if (sourceText[cursor] === "=") {
            cursor += 1;
            while (cursor < end && /\s/.test(sourceText[cursor])) {
                cursor += 1;
            }
            const quote = sourceText[cursor];
            if (quote === '"' || quote === "'") {
                const valueStart = cursor + 1;
                cursor = valueStart;
                while (cursor < end && sourceText[cursor] !== quote) {
                    cursor += 1;
                }
                value = sourceText.slice(valueStart, cursor);
                cursor += cursor < end ? 1 : 0;
            } else if (sourceText[cursor] === "{") {
                const braceEnd = findBalancedBraceEnd(sourceText, cursor);
                cursor = braceEnd !== -1 && braceEnd <= end ? braceEnd + 1 : end;
            } else {
                const valueStart = cursor;
                while (cursor < end && !/[\s>]/.test(sourceText[cursor])) {
                    cursor += 1;
                }
                value = sourceText.slice(valueStart, cursor);
            }
        }
        if (attributeName) {
            attributes.push({ name: attributeName, start, value });
        } else {
            cursor += 1;
        }
    }

    let slashCursor = end - 1;
    while (slashCursor > openIndex && /\s/.test(sourceText[slashCursor])) {
        slashCursor -= 1;
    }
    return {
        end,
        closing: false,
        name,
        selfClosing: sourceText[slashCursor] === "/",
        attributes,
    };
}

export function findRawElementClose(sourceText, tagName, fromIndex) {
    const closeRegex = new RegExp(`</${tagName}\\s*>`, "gi");
    closeRegex.lastIndex = fromIndex;
    const match = closeRegex.exec(sourceText);
    if (!match) {
        return null;
    }
    return { start: match.index, end: match.index + match[0].length };
}
