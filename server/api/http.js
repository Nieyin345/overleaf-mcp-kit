import { applyResponseCookies, getIdentity } from "../session/identity.js";
import { withAuthRetry } from "../session/recovery.js";
import { logger } from "../util/logger.js";
import { OverleafApiError, OverleafAuthError } from "./errors.js";

function joinUrl(base, path) {
    return `${base}/${path.replace(/^\/+/, "")}`;
}

function throwIfAuthBad(res) {
    if (res.status === 401 || res.status === 403) {
        throw new OverleafAuthError(`HTTP ${res.status} on ${res.url || "request"}`);
    }
    if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location") ?? "";
        if (/\/login(\?|$|\/)/i.test(loc)) {
            throw new OverleafAuthError(`redirected to ${loc} — session expired`);
        }
    }
}

const TRANSIENT_NET_CODES = new Set([
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "ECONNRESET",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EAI_AGAIN",
]);

function extractCause(err) {
    if (!err || typeof err !== "object")
        return undefined;
    return err.cause && typeof err.cause === "object" ? err.cause : undefined;
}

export function describeNetworkError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = extractCause(err);
    const code = cause?.code ?? err?.code;
    const detail = cause?.message && cause.message !== msg ? cause.message : "";
    if (code && detail)
        return `${msg} (${code}: ${detail})`;
    if (code)
        return `${msg} (${code})`;
    if (detail)
        return `${msg} (${detail})`;
    return msg;
}

export function isTransientNetworkError(err) {
    if (!err)
        return false;
    const cause = extractCause(err);
    const code = cause?.code ?? err?.code;
    if (code && TRANSIENT_NET_CODES.has(code))
        return true;
    const msg = err instanceof Error ? err.message : String(err);
    if (err?.name === "TypeError" && /fetch failed/i.test(msg)) {
        // Never treat TLS certificate / invalid URL failures as transient socket resets
        if (code && /CERT|SSL|TLS|ERR_INVALID/i.test(String(code)))
            return false;
        return true;
    }
    return false;
}

/**
 * Shared authenticated HTTP executor with auth-expiry retry and optional single
 * transient-network retry (ONLY for idempotent operations such as GET / compile).
 * `buildInit(id)` can be called again cleanly if auth or socket resets.
 */
async function executeAuthed(method, path, buildInit, opts = {}) {
    const canRetryTransient = opts.idempotent ?? (method === "GET" || method === "HEAD");
    return withAuthRetry(async () => {
        const id = await getIdentity();
        const url = joinUrl(id.baseUrl, path);
        const maxAttempts = canRetryTransient ? 2 : 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            logger.debug(`http ${method} ${url}${attempt > 1 ? ` (retry ${attempt}/${maxAttempts})` : ""}`);
            const init = buildInit(id);
            const headers = attempt > 1
                ? { ...init.headers, Connection: "close" }
                : init.headers;
            try {
                const res = await fetch(url, {
                    method,
                    redirect: "manual",
                    ...init,
                    headers,
                });
                throwIfAuthBad(res);
                await applyResponseCookies(id.baseUrl, id.cookie, res.headers);
                return res;
            }
            catch (err) {
                if (err instanceof OverleafAuthError)
                    throw err;
                const detailed = describeNetworkError(err);
                if (attempt < maxAttempts && isTransientNetworkError(err)) {
                    logger.warn(`transient network error on idempotent ${method} ${path}: ${detailed}; retrying with fresh connection`);
                    await new Promise((r) => setTimeout(r, 350));
                    continue;
                }
                if (isTransientNetworkError(err) || (err?.name === "TypeError" && /fetch failed/i.test(err.message))) {
                    const wrapped = new Error(`HTTP ${method} ${path} failed: ${detailed}`);
                    wrapped.cause = err;
                    throw wrapped;
                }
                throw err;
            }
        }
    });
}

export async function olGet(path, extraHeaders = {}, opts = {}) {
    return executeAuthed("GET", path, (id) => ({
        headers: { Cookie: id.cookie, Connection: "keep-alive", ...extraHeaders },
    }), { idempotent: true, ...opts });
}

export async function olPostJson(path, body = {}, extraHeaders = {}, opts = {}) {
    return executeAuthed("POST", path, (id) => ({
        headers: {
            Cookie: id.cookie,
            Connection: "keep-alive",
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "X-Csrf-Token": id.csrf,
            ...extraHeaders,
        },
        body: JSON.stringify({ _csrf: id.csrf, ...body }),
    }), { idempotent: false, ...opts });
}

/**
 * Multipart/form-data POST (used for Overleaf /upload endpoint).
 * Accepts a factory `buildFormData()` so retries reconstruct a fresh FormData.
 */
export async function olPostMultipart(path, buildFormData, extraHeaders = {}, opts = {}) {
    return executeAuthed("POST", path, (id) => ({
        headers: {
            Cookie: id.cookie,
            Connection: "keep-alive",
            Accept: "application/json, text/plain, */*",
            "X-Csrf-Token": id.csrf,
            ...extraHeaders,
        },
        body: buildFormData(id),
    }), { idempotent: false, ...opts });
}

export async function olDelete(path, extraHeaders = {}, opts = {}) {
    return executeAuthed("DELETE", path, (id) => ({
        headers: {
            Cookie: id.cookie,
            Connection: "keep-alive",
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "X-Csrf-Token": id.csrf,
            ...extraHeaders,
        },
    }), { idempotent: false, ...opts });
}

export async function expectOk(res, hint) {
    if (res.ok)
        return res;
    throwIfAuthBad(res);
    const body = await res.text().catch(() => "");
    throw new OverleafApiError(res.status, body, hint);
}

export async function asJson(res, hint) {
    await expectOk(res, hint);
    return (await res.json());
}

export async function olGetBuffer(path, hint, extraHeaders = {}) {
    const res = await olGet(path, extraHeaders);
    await expectOk(res, hint ?? `GET ${path}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    return { buffer, contentType, res };
}
