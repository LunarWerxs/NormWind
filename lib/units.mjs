// Length arithmetic used when enumerating the values a canonical
// utility can be written as. Pure; no Tailwind, no I/O.

import { ROOT_FONT_SIZE_PX } from "./constants.mjs";

export function toFixedTrim(value) {
    const asString = Number(value.toFixed(6)).toString();
    return asString === "-0" ? "0" : asString;
}

export function parseSingleLength(input) {
    const normalized = String(input ?? "").trim();
    const match = normalized.match(/^(-?\d*\.?\d+)(rem|px|em|%)$/i);
    if (!match) {
        return null;
    }

    return {
        number: Number(match[1]),
        unit: match[2].toLowerCase(),
    };
}

export function multiplyLength(lengthValue, factor) {
    const parsed = parseSingleLength(lengthValue);
    if (!parsed || Number.isNaN(factor)) {
        return null;
    }

    const multiplied = parsed.number * factor;
    return `${toFixedTrim(multiplied)}${parsed.unit}`;
}

export function remToPx(lengthValue, remPx = ROOT_FONT_SIZE_PX) {
    const parsed = parseSingleLength(lengthValue);
    if (!parsed || parsed.unit !== "rem") {
        return null;
    }

    return `${toFixedTrim(parsed.number * remPx)}px`;
}

export function pxToRem(lengthValue, remPx = ROOT_FONT_SIZE_PX) {
    const parsed = parseSingleLength(lengthValue);
    if (!parsed || parsed.unit !== "px" || remPx === 0) {
        return null;
    }

    return `${toFixedTrim(parsed.number / remPx)}rem`;
}

export function expandValueVariants(value) {
    const variants = new Set([value]);

    const px = remToPx(value);
    if (px) {
        variants.add(px);
    }

    const rem = pxToRem(value);
    if (rem) {
        variants.add(rem);
    }

    return [...variants];
}

export function extractFractionPercent(fraction) {
    if (!fraction || !fraction.includes("/")) {
        return null;
    }

    const [leftRaw, rightRaw] = fraction.split("/");
    const left = Number(leftRaw);
    const right = Number(rightRaw);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) {
        return null;
    }

    return `${toFixedTrim((left / right) * 100)}%`;
}
