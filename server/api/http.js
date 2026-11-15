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

/**
 * Shared authenticated HTTP executor with retry on auth expiry.
 * `buildInit(id)` can be called again cleanly if auth refreshes.
 */
async function executeAuthed(method, path, buildInit) {
    return withAuthRetry(async () => {
        const id = await getIdentity();
        const url = joinUrl(id.baseUrl, path);
        logger.debug(`http ${method} ${url}`);
        const init = buildInit(id);
        const res = await fetch(url, {
            method,
            redirect: "manual",
            ...init,
        });
        throwIfAuthBad(res);
        await applyResponseCookies(id.baseUrl, id.cookie, res.headers);
        return res;
    });
}

export async function olGet(path, extraHeaders = {}) {
    return executeAuthed("GET", path, (id) => ({
        headers: { Cookie: id.cookie, Connection: "keep-alive", ...extraHeaders },
    }));
}

export async function olPostJson(path, body = {}, extraHeaders = {}) {
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
    }));
}

/**
 * Multipart/form-data POST (used for Overleaf /upload endpoint).
 * Accepts a factory `buildFormData()` so retries reconstruct a fresh FormData.
 */
export async function olPostMultipart(path, buildFormData, extraHeaders = {}) {
    return executeAuthed("POST", path, (id) => ({
        headers: {
            Cookie: id.cookie,
            Connection: "keep-alive",
            Accept: "application/json, text/plain, */*",
            "X-Csrf-Token": id.csrf,
            ...extraHeaders,
        },
        body: buildFormData(id),
    }));
}

export async function olDelete(path, extraHeaders = {}) {
    return executeAuthed("DELETE", path, (id) => ({
        headers: {
            Cookie: id.cookie,
            Connection: "keep-alive",
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "X-Csrf-Token": id.csrf,
            ...extraHeaders,
        },
    }));
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
