// Cookie discovery orchestrator: file first, browser-launch as fallback.
// No env-var path — the file is the only persistent store, and a stale
// cookie always recovers by re-launching Chrome. Concurrent callers for
// the same host share one in-flight promise.
import { logger } from "../util/logger.js";
import { loadStored, saveStored, clearStored } from "./cookieStore.js";
import { captureCookieWithMeta } from "./browserLogin.js";
const pending = new Map();
function hostKey(baseUrl) {
    return new URL(baseUrl).host;
}
async function runDiscovery(baseUrl) {
    const stored = await loadStored(baseUrl);
    if (stored?.cookie) {
        logger.debug(`auth: using stored cookie for ${hostKey(baseUrl)} (saved ${new Date(stored.savedAt).toISOString()})`);
        return stored.cookie;
    }
    logger.info(`auth: no stored cookie for ${hostKey(baseUrl)}, launching browser to capture one`);
    const captured = await captureCookieWithMeta(baseUrl);
    await saveStored(baseUrl, captured.cookie, { serverExpiresAt: captured.serverExpiresAt });
    return captured.cookie;
}
export async function discoverCookie(baseUrl) {
    const key = hostKey(baseUrl);
    const existing = pending.get(key);
    if (existing)
        return existing;
    const p = runDiscovery(baseUrl).finally(() => {
        pending.delete(key);
    });
    pending.set(key, p);
    return p;
}
export async function evictAndRediscover(baseUrl) {
    await clearStored(baseUrl).catch(() => undefined);
    pending.delete(hostKey(baseUrl));
    return discoverCookie(baseUrl);
}
//# sourceMappingURL=discover.js.map