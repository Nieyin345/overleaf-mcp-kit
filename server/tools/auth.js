import { z } from "zod";
import { loadConfig } from "../config.js";
import { cookieFilePath, loadStored } from "../auth/cookieStore.js";
import { validateCookie } from "../session/identity.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
    verify: z
        .boolean()
        .default(true)
        .describe("If true (default), verify the stored cookie live against Overleaf without popping up a browser."),
});

export function registerAuthTools(server) {
    server.registerTool("auth_status", {
        title: "Check Overleaf login status and current account",
        description: "Checks whether a valid Overleaf session cookie is cached locally and optionally verifies it live against Overleaf (never launches a browser window).",
        inputSchema: Schema.shape,
        annotations: { readOnlyHint: true, idempotentHint: true },
    }, async (args) => {
        const config = loadConfig();
        const file = cookieFilePath();
        const stored = await loadStored(config.baseUrl);
        if (!stored?.cookie) {
            const payload = {
                authenticated: false,
                base_url: config.baseUrl,
                cookie_file: file,
                reason: "no_stored_cookie",
            };
            return {
                content: [{ type: "text", text: `Not logged in to ${config.baseUrl}. No stored cookie at ${file}.` }],
                structuredContent: payload,
            };
        }

        const ageMs = Math.max(0, Date.now() - (stored.savedAt || Date.now()));
        const ageHours = Math.round((ageMs / 3_600_000) * 10) / 10;
        const savedAtIso = stored.savedAt ? new Date(stored.savedAt).toISOString() : undefined;
        const localExpiresIso = stored.localExpiresAt ? new Date(stored.localExpiresAt).toISOString() : undefined;
        const serverExpiresIso = stored.serverExpiresAt ? new Date(stored.serverExpiresAt).toISOString() : undefined;

        if (!args.verify) {
            const payload = {
                authenticated: true,
                verified_live: false,
                base_url: config.baseUrl,
                saved_at: savedAtIso,
                local_expires_at: localExpiresIso,
                server_expires_at: serverExpiresIso,
                cookie_ttl_days: config.cookieTtlDays,
                keepalive_min: config.cookieKeepAliveMin,
                age_hours: ageHours,
                cookie_file: file,
            };
            return {
                content: [{ type: "text", text: `Stored cookie present for ${config.baseUrl} (saved ${ageHours}h ago, local TTL=${config.cookieTtlDays === 0 ? "unlimited" : `${config.cookieTtlDays}d`}, not live-verified).` }],
                structuredContent: payload,
            };
        }

        try {
            const id = await validateCookie(stored.cookie, config);
            const payload = {
                authenticated: true,
                verified_live: true,
                base_url: config.baseUrl,
                user_id: id.userId,
                user_email: id.userEmail || undefined,
                saved_at: savedAtIso,
                local_expires_at: localExpiresIso,
                server_expires_at: serverExpiresIso,
                cookie_ttl_days: config.cookieTtlDays,
                keepalive_min: config.cookieKeepAliveMin,
                age_hours: ageHours,
                cookie_file: file,
            };
            logger.info(`auth_status verified: ${id.userEmail || id.userId}`);
            return {
                content: [{ type: "text", text: `Authenticated on ${config.baseUrl} as ${id.userEmail || id.userId} (cookie age: ${ageHours}h, local TTL: ${config.cookieTtlDays === 0 ? "unlimited" : `${config.cookieTtlDays}d`}, keep-alive: ${config.cookieKeepAliveMin}m).` }],
                structuredContent: payload,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("auth_status verification failed", msg);
            const payload = {
                authenticated: false,
                verified_live: true,
                base_url: config.baseUrl,
                saved_at: savedAtIso,
                age_hours: ageHours,
                cookie_file: file,
                reason: msg,
            };
            return {
                content: [{ type: "text", text: `Session invalid or expired for ${config.baseUrl}: ${msg}` }],
                structuredContent: payload,
            };
        }
    });
}
