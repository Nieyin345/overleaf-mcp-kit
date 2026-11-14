// Plaintext cookie persistence keyed by Overleaf host.
//
// Stores a single JSON map at <configDir>/overleaf-mcp/cookie.json with mode
// 0600. Multi-host so the same machine can hold credentials for overleaf.com
// and a self-hosted CE side-by-side. Supports configurable local retention
// (`OL_COOKIE_TTL_DAYS`, default 30 days; 0 disables local expiry) and sliding
// refresh persistence whenever Overleaf rotates Set-Cookie headers.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { logger } from "../util/logger.js";

function configRoot() {
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support");
    }
    if (process.platform === "win32") {
        return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    }
    return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export function cookieFilePath() {
    return path.join(configRoot(), "overleaf-mcp", "cookie.json");
}

function hostKey(baseUrl) {
    return new URL(baseUrl).host;
}

async function readStore() {
    try {
        const raw = await fs.readFile(cookieFilePath(), "utf8");
        const parsed = JSON.parse(raw);
        return { hosts: parsed.hosts ?? {} };
    }
    catch (err) {
        if (err?.code === "ENOENT")
            return { hosts: {} };
        logger.warn(`cookie store unreadable, treating as empty: ${err.message}`);
        return { hosts: {} };
    }
}

async function writeStore(store) {
    const file = cookieFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.chmod(tmp, 0o600).catch(() => undefined);
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
}

export async function loadStored(baseUrl) {
    const store = await readStore();
    const entry = store.hosts[hostKey(baseUrl)] ?? null;
    if (!entry?.cookie)
        return null;
    const { cookieTtlDays } = loadConfig();
    if (cookieTtlDays > 0 && entry.savedAt) {
        const maxLocalExpiresAt = entry.savedAt + cookieTtlDays * 86_400_000;
        if (Date.now() > maxLocalExpiresAt) {
            logger.info(`stored cookie exceeded local retention (${cookieTtlDays} days), re-login required`);
            return null;
        }
    }
    return entry;
}

export async function saveStored(baseUrl, cookie, meta = {}) {
    const store = await readStore();
    const key = hostKey(baseUrl);
    const prev = store.hosts[key] ?? {};
    const { cookieTtlDays } = loadConfig();
    const now = Date.now();
    const localExpiresAt = cookieTtlDays > 0 ? now + cookieTtlDays * 86_400_000 : null;
    store.hosts[key] = {
        cookie,
        savedAt: now,
        localExpiresAt,
        serverExpiresAt: meta.serverExpiresAt !== undefined ? meta.serverExpiresAt : (prev.serverExpiresAt ?? null),
    };
    await writeStore(store);
}

export async function clearStored(baseUrl) {
    const store = await readStore();
    const key = hostKey(baseUrl);
    if (!(key in store.hosts))
        return false;
    delete store.hosts[key];
    await writeStore(store);
    return true;
}
