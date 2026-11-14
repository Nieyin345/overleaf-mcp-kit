import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hereDir = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(hereDir, "..");

function readFileConfig() {
    const cfgFile = process.env.OL_CONFIG_PATH
        ? path.resolve(process.env.OL_CONFIG_PATH)
        : path.join(kitRoot, "config.json");
    if (!existsSync(cfgFile))
        return {};
    try {
        return JSON.parse(readFileSync(cfgFile, "utf8").replace(/^\uFEFF/, ""));
    }
    catch {
        return {};
    }
}

export function loadConfig() {
    const fc = readFileConfig();
    const dataDir = process.env.OL_DATA_DIR?.trim() || kitRoot;
    const rawBase = process.env.OL_BASE_URL ?? (fc.OL_BASE_URL || "https://www.overleaf.com");
    const baseUrl = String(rawBase).replace(/\/+$/, "");
    const rawPublic = process.env.OL_PUBLIC_URL?.trim();
    const publicUrl = rawPublic ? rawPublic.replace(/\/+$/, "") : undefined;
    const ttlMinutes = Number(process.env.OL_ARTIFACT_TTL_MIN ?? fc.ARTIFACT_TTL_MIN);
    const artifactTtlMs = (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 60) * 60_000;
    const rawCookieDays = process.env.OL_COOKIE_TTL_DAYS ?? fc.COOKIE_TTL_DAYS;
    const parsedDays = rawCookieDays !== undefined && rawCookieDays !== "" ? Number(rawCookieDays) : 30;
    const cookieTtlDays = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 30;
    const rawKeepAlive = process.env.OL_COOKIE_KEEPALIVE_MIN ?? fc.COOKIE_KEEPALIVE_MIN;
    const parsedKeepAlive = rawKeepAlive !== undefined && rawKeepAlive !== "" ? Number(rawKeepAlive) : 180;
    const cookieKeepAliveMin = Number.isFinite(parsedKeepAlive) && parsedKeepAlive >= 0 ? parsedKeepAlive : 180;
    return {
        baseUrl,
        publicUrl,
        artifactDir: process.env.OL_ARTIFACT_DIR?.trim() || path.join(dataDir, "artifacts"),
        downloadDir: process.env.OL_DOWNLOAD_DIR?.trim() || path.join(dataDir, "downloads"),
        artifactTtlMs,
        cookieTtlDays,
        cookieKeepAliveMin,
        csrfOverride: process.env.OL_CSRF?.trim() || undefined,
        browserPath: process.env.OL_BROWSER?.trim() || (fc.OL_BROWSER ? String(fc.OL_BROWSER).trim() : undefined),
        insecure: process.env.OL_INSECURE === "1" || fc.OL_INSECURE === true || fc.OL_INSECURE === "1",
    };
}
