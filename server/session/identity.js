import { loadConfig } from "../config.js";
import { OverleafAuthError } from "../api/errors.js";
import { logger } from "../util/logger.js";
import { discoverCookie } from "../auth/discover.js";
import { loadStored, saveStored } from "../auth/cookieStore.js";
import { mergeSetCookiesDetailed } from "../util/cookies.js";

let cached = null;
let pending = null;
let keepAliveTimer = null;

function extractMeta(html, name) {
    const re = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']`);
    return html.match(re)?.[1];
}

export async function validateCookie(cookie, config = loadConfig()) {
    return resolveIdentity(cookie, config);
}

/**
 * Persists rotated `Set-Cookie` headers into `cookie.json` and active memory
 * whenever Overleaf renews session/sticky cookies on an HTTP response.
 */
export async function applyResponseCookies(baseUrl, currentCookie, responseHeaders) {
    const merged = mergeSetCookiesDetailed(currentCookie, responseHeaders);
    if (!merged.changed)
        return currentCookie;
    if (cached && cached.baseUrl === baseUrl) {
        cached = { ...cached, cookie: merged.cookie };
    }
    if (merged.hasSessionUpdate) {
        await saveStored(baseUrl, merged.cookie).catch((err) => {
            logger.warn(`failed to persist refreshed session cookie: ${err.message}`);
        });
        logger.info("session cookie refreshed from Overleaf Set-Cookie and saved locally");
    }
    return merged.cookie;
}

async function resolveIdentity(cookie, config) {
    const url = `${config.baseUrl}/project`;
    const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { Cookie: cookie, Connection: "keep-alive" },
    });
    if (res.status === 301 || res.status === 302) {
        const location = res.headers.get("location") ?? "";
        throw new OverleafAuthError(`Session cookie rejected (redirected to ${location || "login"}). ` +
            "The cookie is likely expired — run `overleaf-mcp login` to refresh.");
    }
    if (!res.ok) {
        throw new OverleafAuthError(`GET /project returned HTTP ${res.status}`);
    }
    const updatedCookie = await applyResponseCookies(config.baseUrl, cookie, res.headers);
    const html = await res.text();
    const userId = extractMeta(html, "ol-user_id");
    const userEmail = extractMeta(html, "ol-usersEmail") ?? "";
    const csrf = config.csrfOverride ?? extractMeta(html, "ol-csrfToken");
    if (!userId) {
        throw new OverleafAuthError("Could not find ol-user_id meta tag on /project page. " +
            "The cookie may be invalid or this is an unsupported Overleaf version.");
    }
    if (!csrf) {
        throw new OverleafAuthError("Could not find ol-csrfToken meta tag and OL_CSRF was not set. " +
            "Pass OL_CSRF as a fallback or check that your Overleaf server emits the meta tag.");
    }
    logger.info(`authenticated as ${userEmail || userId}`);
    return { baseUrl: config.baseUrl, cookie: updatedCookie, csrf, userId, userEmail };
}

export async function getIdentity() {
    if (cached)
        return cached;
    if (pending)
        return pending;
    const config = loadConfig();
    pending = (async () => {
        const cookie = await discoverCookie(config.baseUrl);
        return resolveIdentity(cookie, config);
    })()
        .then((id) => {
        cached = id;
        return id;
    })
        .finally(() => {
        pending = null;
    });
    return pending;
}

export function clearIdentity() {
    cached = null;
}

/**
 * Periodically pings Overleaf `/project` using the cached cookie so sliding
 * sessions refresh via `Set-Cookie` instead of expiring silently during idle use.
 */
export function startSessionKeepAlive() {
    stopSessionKeepAlive();
    const config = loadConfig();
    if (!config.cookieKeepAliveMin || config.cookieKeepAliveMin <= 0)
        return;
    const intervalMs = Math.max(60_000, config.cookieKeepAliveMin * 60_000);
    keepAliveTimer = setInterval(async () => {
        try {
            const cfg = loadConfig();
            const stored = cached?.cookie ? { cookie: cached.cookie } : await loadStored(cfg.baseUrl);
            if (!stored?.cookie)
                return;
            const id = await resolveIdentity(stored.cookie, cfg);
            cached = id;
            logger.debug(`session keep-alive verified (${id.userEmail || id.userId})`);
        }
        catch (err) {
            logger.warn(`session keep-alive check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, intervalMs);
    keepAliveTimer.unref?.();
}

export function stopSessionKeepAlive() {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}
