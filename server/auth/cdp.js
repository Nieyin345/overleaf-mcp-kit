// Minimal Chrome DevTools Protocol client over ws@8. Just enough to drive
// a single visible Chrome window: create a tab, navigate, poll location,
// read cookies, close the tab. No retries, no domain abstractions —
// callers compose commands themselves.
import WebSocket from "ws";
import { logger } from "../util/logger.js";
export class CdpClient {
    ws;
    nextId = 1;
    pending = new Map();
    listeners = new Map();
    closed = false;
    closeWaiters = [];
    constructor(ws) {
        this.ws = ws;
        ws.on("message", (data) => this.handleMessage(data.toString("utf8")));
        ws.on("close", () => {
            this.closed = true;
            for (const [, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new Error(`CDP socket closed before '${p.method}' completed`));
            }
            this.pending.clear();
            const waiters = this.closeWaiters;
            this.closeWaiters = [];
            for (const w of waiters)
                w();
        });
        ws.on("error", (err) => logger.debug(`cdp ws error: ${err.message}`));
    }
    static async connect(url, timeoutMs = 10_000) {
        const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`CDP connect to ${url} timed out`)), timeoutMs);
            ws.once("open", () => { clearTimeout(timer); resolve(); });
            ws.once("error", (err) => { clearTimeout(timer); reject(err); });
        });
        return new CdpClient(ws);
    }
    handleMessage(text) {
        let msg;
        try {
            msg = JSON.parse(text);
        }
        catch {
            return;
        }
        if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (!p)
                return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error)
                p.reject(new Error(`CDP ${p.method} failed: ${msg.error.message}`));
            else
                p.resolve(msg.result ?? {});
            return;
        }
        if (msg.method) {
            const ls = this.listeners.get(msg.method);
            if (ls)
                for (const l of ls)
                    try {
                        l(msg.params ?? {}, msg.sessionId);
                    }
                    catch (e) {
                        logger.warn(`cdp listener for ${msg.method} threw: ${e.message}`);
                    }
        }
    }
    on(event, listener) {
        const arr = this.listeners.get(event) ?? [];
        arr.push(listener);
        this.listeners.set(event, arr);
    }
    async send(method, params = {}, sessionId, timeoutMs = 15_000) {
        if (this.closed)
            throw new Error(`CDP socket already closed (sending ${method})`);
        const id = this.nextId++;
        const frame = { id, method, params };
        if (sessionId)
            frame.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (r) => resolve(r),
                reject,
                timer,
                method,
            });
            try {
                this.ws.send(JSON.stringify(frame));
            }
            catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            }
        });
    }
    isClosed() {
        return this.closed;
    }
    onClose(cb) {
        if (this.closed) {
            cb();
            return;
        }
        this.closeWaiters.push(cb);
    }
    close() {
        if (this.closed)
            return;
        try {
            this.ws.close();
        }
        catch { /* ignore */ }
    }
}
//# sourceMappingURL=cdp.js.map