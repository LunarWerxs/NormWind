// Anonymous install ping to LunarWerx's Studio proxy. The endpoint relays
// GitHub's releases/latest JSON for LunarWerxs/NormWind verbatim, so this
// ping doubles as NormWind's only update-check network call; nothing else in
// the CLI reaches the network during a normal audit or fix run. Modeled on
// the same contract QuickDictate and AnatomyOf already ship in prod: a
// random install id, the running version, and a coarse OS tag, nothing more.
// See README.md "Privacy" for the full disclosure of what is (and isn't)
// sent, and SECURITY.md for the endpoint itself.
//
// Fire-and-forget by design: `sendInstallPing` never rejects, and every
// failure (offline, DNS, a non-2xx response, a slow connection) is swallowed
// silently. Nothing here can fail, slow past its own timeout, or crash an
// audit run.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PING_URL = "https://studio.connections.icu/v1/app/normwind/latest";

// A per-user state file, independent of any scanned project: an install id
// must survive across every repo the CLI is ever pointed at, and `npx`
// usually leaves no persistent node_modules to keep it in.
const STATE_DIR = path.join(os.homedir(), ".normwind");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const PING_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PING_TIMEOUT_MS = 5000;

function coarseOsTag() {
    const platform = os.platform();
    if (platform === "win32") {
        const build = Number.parseInt(os.release().split(".")[2] ?? "", 10);
        if (Number.isNaN(build)) return "windows";
        return `${build >= 22000 ? "win11" : "win10"}-${build}`;
    }
    if (platform === "darwin") return "macos";
    if (platform === "linux") return "linux";
    return platform;
}

// No dev-mode flag exists yet in this repo, so NODE_ENV=test and a generic
// CI env var are the two signals used to keep dev/test/CI runs silent. The
// GitHub Action's spawned CLI subprocess is covered separately and more
// strictly: action/index.mjs's scannerEnvironment allowlist strips CI (and
// everything else not explicitly named) before the child ever sees it, so it
// sets NORMWIND_NO_PING=1 itself rather than relying on ambient env.
function pingDisabled() {
    return (
        process.env.NORMWIND_NO_PING === "1" ||
        Boolean(process.env.CI) ||
        process.env.NODE_ENV === "test"
    );
}

async function loadState() {
    try {
        const raw = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
        return {
            installId: typeof raw.installId === "string" ? raw.installId : "",
            lastPingedAt: typeof raw.lastPingedAt === "number" ? raw.lastPingedAt : 0,
            reported: raw.reported === true,
        };
    } catch {
        return { installId: "", lastPingedAt: 0, reported: false };
    }
}

async function saveState(state) {
    try {
        await fs.mkdir(STATE_DIR, { recursive: true });
        await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    } catch {
        // Best-effort only: a failed persist just means the next run tries
        // again (a fresh install id, or an unthrottled ping).
    }
}

/**
 * Fire the anonymous install ping in the background. Always resolves, never
 * rejects. Call it once real work is about to start, without awaiting it
 * immediately, so the network round trip overlaps with the scan/fix work
 * instead of adding latency of its own; await the returned promise once,
 * right before the process would otherwise exit, so it gets its full window
 * (capped at PING_TIMEOUT_MS) to complete.
 *
 * @param {string} version - NORMWINDS_VERSION, sent as `?v=`.
 */
export async function sendInstallPing(version) {
    try {
        if (pingDisabled()) return;

        const state = await loadState();
        const now = Date.now();
        if (state.installId && now - state.lastPingedAt < PING_INTERVAL_MS) return;

        const installId = state.installId || randomUUID();
        // Persisted only after a successful ping (see saveState below), so
        // `&new=1` rides every attempt until one actually lands, exactly
        // like QuickDictate's install-reported flag.
        const isFirstPing = !state.reported;
        const params = new URLSearchParams({ v: version, os: coarseOsTag() });
        if (isFirstPing) params.set("new", "1");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
        timer.unref?.();
        let ok = false;
        try {
            const response = await fetch(`${PING_URL}?${params.toString()}`, {
                headers: { "X-Install-Id": installId },
                signal: controller.signal,
            });
            ok = response.ok;
        } finally {
            clearTimeout(timer);
        }

        // lastPingedAt advances on every attempt, success or failure, so an
        // offline machine gets throttled the same as an online one instead
        // of re-attempting on every single invocation (no retry loops).
        await saveState({
            installId,
            lastPingedAt: now,
            reported: state.reported || ok,
        });
    } catch {
        // Fire-and-forget: telemetry must never affect the audit run.
    }
}
