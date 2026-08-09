// Glob matching for the no-ripgrep fallback walker.

export function hasGlobSyntax(value) {
    return /[*?[\]{}]/.test(value);
}

// Minimal glob-to-RegExp conversion covering the syntax the CLI documents
// (`**`, `*`, `?`, `{a,b}`), so the no-ripgrep fallback honors the same
// patterns instead of returning every file in the tree.
export function globPatternToRegExp(pattern) {
    const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    let out = "";
    for (let i = 0; i < normalized.length; i += 1) {
        const ch = normalized[i];
        if (ch === "*") {
            if (normalized[i + 1] === "*") {
                if (normalized[i + 2] === "/") {
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
            const close = normalized.indexOf("}", i);
            if (close === -1) {
                out += "\\{";
                continue;
            }
            const alts = normalized
                .slice(i + 1, close)
                .split(",")
                .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            out += `(?:${alts.join("|")})`;
            i = close;
        } else {
            out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
    }

    // Like ripgrep: a pattern containing "/" anchors at the tree root; a bare
    // pattern matches against the basename at any depth.
    return normalized.includes("/")
        ? new RegExp(`^${out}$`)
        : new RegExp(`(?:^|/)${out}$`);
}
