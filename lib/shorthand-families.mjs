// The shorthand family table, derived from eslint-plugin-tailwindcss groups.
//
// A "family" is one shorthand target plus the longhands it can absorb
// (`ml`/`mr` into `mx`, the four `rounded-*` corners into `rounded`). Audit,
// merge and fix all read this one table and its body index, so a family can
// never mean two different things in two places.

import { loadTailwind } from "./design-system.mjs";

const COMPLEX_EQUIVALENCES = {
    placeContentOptions: [
        "center",
        "start",
        "end",
        "between",
        "around",
        "evenly",
        "baseline",
        "stretch",
    ],
    placeItemsOptions: ["start", "end", "center", "stretch"],
    placeSelfOptions: ["auto", "start", "end", "center", "stretch"],
};

function buildShorthandFamilies(groups) {
    const targetTypes = new Set([
        "Layout",
        "Flexbox & Grid",
        "Spacing",
        "Sizing",
        "Borders",
        "Tables",
        "Transforms",
        "Typography",
    ]);

    const families = [];

    for (const group of groups) {
        if (!targetTypes.has(group.type) || !Array.isArray(group.members)) {
            continue;
        }

        for (const parent of group.members) {
            if (!Array.isArray(parent.members)) {
                continue;
            }

            const entries = parent.members
                .filter((entry) => entry && typeof entry.body === "string" && typeof entry.shorthand === "string")
                .map((entry) => ({ body: entry.body, shorthand: entry.shorthand }));

            if (entries.length < 2) {
                continue;
            }

            const shorthandToBody = new Map();
            for (const entry of entries) {
                shorthandToBody.set(entry.shorthand, entry.body);
            }

            families.push({
                group: group.type,
                parent: parent.type,
                entries: [...entries].sort((a, b) => b.body.length - a.body.length),
                shorthandToBody,
                supportsCorners: entries.some((entry) => ["tl", "tr", "br", "bl"].includes(entry.shorthand)),
            });
        }
    }

    return families;
}

let shorthandFamiliesCache = null;
let familyBodyIndexCache = null;
function getShorthandFamilies() {
    if (!shorthandFamiliesCache) {
        const { tailwindGroups } = loadTailwind();
        shorthandFamiliesCache = buildShorthandFamilies(tailwindGroups);
        familyBodyIndexCache = buildFamilyBodyIndex(shorthandFamiliesCache);
    }
    return { families: shorthandFamiliesCache, bodyIndex: familyBodyIndexCache };
}


function buildFamilyBodyIndex(families) {
    const index = new Map();

    for (const family of families) {
        for (const entry of family.entries) {
            if (!index.has(entry.body)) {
                index.set(entry.body, []);
            }

            index.get(entry.body).push({
                family,
                shorthand: entry.shorthand,
            });
        }
    }

    return index;
}

export { COMPLEX_EQUIVALENCES, getShorthandFamilies };
