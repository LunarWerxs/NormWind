// Glob matching for file discovery and ignore patterns.
//
// The one glob dialect NormWind speaks: `**`, `*`, `?` and `{a,b}` (whose
// alternatives may themselves hold wildcards, e.g. `{*.test,*.spec}.tsx`).
// `[` and `]` are LITERAL, never a character class, so a framework's dynamic
// route folder (`app/[slug]/**`) matches itself.

export function hasGlobSyntax(value) {
    return /[*?{}]/.test(value);
}

// Index of the `}` closing the `{` at `open`, honouring nesting; -1 if none.
function findBraceClose(pattern, open) {
    let depth = 0;
    for (let i = open; i < pattern.length; i += 1) {
        if (pattern[i] === "{") {
            depth += 1;
        } else if (pattern[i] === "}") {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

// Split a brace body on its top-level commas only.
function splitBraceAlternatives(body) {
    const alternatives = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < body.length; i += 1) {
        if (body[i] === "{") {
            depth += 1;
        } else if (body[i] === "}") {
            depth -= 1;
        } else if (body[i] === "," && depth === 0) {
            alternatives.push(body.slice(start, i));
            start = i + 1;
        }
    }
    alternatives.push(body.slice(start));
    return alternatives;
}

function globToRegexSource(pattern) {
    let out = "";
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                if (pattern[i + 2] === "/") {
                    out += "(?:[^/]+/)*";
                    i += 2;
                } else {
                    out += ".*";
                    i += 1;
                }
            } else {
                out += "[^/]*";
            }
        } else if (ch === "?") {
            out += "[^/]";
        } else if (ch === "{") {
            const close = findBraceClose(pattern, i);
            if (close === -1) {
                out += "\\{";
                continue;
            }
            const alternatives = splitBraceAlternatives(pattern.slice(i + 1, close)).map(globToRegexSource);
            out += `(?:${alternatives.join("|")})`;
            i = close;
        } else {
            out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
    }
    return out;
}

export function globPatternToRegExp(pattern) {
    const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    const out = globToRegexSource(normalized);

    // A pattern containing "/" anchors at the scan root; a bare pattern
    // matches against the basename at any depth.
    return normalized.includes("/")
        ? new RegExp(`^${out}$`)
        : new RegExp(`(?:^|/)${out}$`);
}
