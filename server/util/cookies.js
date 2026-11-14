// Shared cookie header merging & expiration inspection helpers.

/**
 * Merges any `Set-Cookie` headers from a Fetch `Response` into an existing
 * semicolon-separated `Cookie` request header string.
 * Returns `{ cookie, changed, hasSessionUpdate }`.
 */
export function mergeSetCookiesDetailed(existing, responseHeaders) {
    const headersAny = responseHeaders;
    const raw = headersAny?.getSetCookie?.() ?? [];
    if (!raw.length && typeof responseHeaders?.get === "function") {
        const single = responseHeaders.get("set-cookie");
        if (single)
            raw.push(single);
    }
    if (!raw.length) {
        return { cookie: existing, changed: false, hasSessionUpdate: false };
    }

    const cookieMap = new Map();
    const order = [];
    for (const part of String(existing || "").split(";")) {
        const trimmed = part.trim();
        if (!trimmed)
            continue;
        const eq = trimmed.indexOf("=");
        const key = (eq >= 0 ? trimmed.slice(0, eq) : trimmed).trim().toLowerCase();
        if (!cookieMap.has(key))
            order.push(key);
        cookieMap.set(key, trimmed);
    }

    let changed = false;
    let hasSessionUpdate = false;
    for (const sc of raw) {
        const first = String(sc).split(";")[0].trim();
        const eq = first.indexOf("=");
        const key = (eq >= 0 ? first.slice(0, eq) : first).trim().toLowerCase();
        if (!key)
            continue;
        if (!cookieMap.has(key)) {
            order.push(key);
            changed = true;
        }
        else if (cookieMap.get(key) !== first) {
            changed = true;
        }
        if (key === "overleaf_session2" || key === "sharelatex.sid") {
            hasSessionUpdate = true;
        }
        cookieMap.set(key, first);
    }

    return {
        cookie: order.map((k) => cookieMap.get(k)).join("; "),
        changed,
        hasSessionUpdate,
    };
}

export function mergeSetCookies(existing, responseHeaders) {
    return mergeSetCookiesDetailed(existing, responseHeaders).cookie;
}
