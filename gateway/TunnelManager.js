import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Manages public tunnel exposure:
 *  - "custom": user-owned domain via system Cloudflared service
 *  - "quick" : zero-config free HTTPS URL via `cloudflared tunnel --url ...`
 *  - "local" : localhost-only without public tunnel
 */
export class TunnelManager {
    constructor(kitRoot) {
        this.kitRoot = path.resolve(kitRoot);
        this.child = null;
        this.publicUrl = null;
    }

    static resolveMode(cfg) {
        const mode = String(cfg.TUNNEL_MODE || "auto").trim().toLowerCase();
        const hostname = String(cfg.HOSTNAME || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
        if (mode === "local")
            return { mode: "local", hostname: "" };
        if (mode === "quick")
            return { mode: "quick", hostname: "" };
        if (mode === "custom")
            return { mode: "custom", hostname };
        // "auto": custom domain if configured, otherwise zero-domain Quick Tunnel
        return hostname ? { mode: "custom", hostname } : { mode: "quick", hostname: "" };
    }

    findCloudflaredBinary() {
        const candidates = [
            path.join(this.kitRoot, "bin", "cloudflared.exe"),
            path.join(this.kitRoot, "cloudflared.exe"),
            "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
            "C:\\Program Files\\cloudflared\\cloudflared.exe",
        ];
        for (const c of candidates) {
            if (existsSync(c))
                return c;
        }
        try {
            const out = execSync("where.exe cloudflared", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
            if (first && existsSync(first))
                return first;
        }
        catch {
            // not on PATH
        }
        return null;
    }

    checkCustomServiceRunning() {
        try {
            const out = execSync("sc query Cloudflared", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            return out.includes("RUNNING") ? "running" : "stopped";
        }
        catch {
            return "missing";
        }
    }

    async startQuickTunnel(localPort, timeoutMs = 30_000) {
        const bin = this.findCloudflaredBinary();
        if (!bin) {
            throw new Error(
                "cloudflared.exe not found (checked ./bin/cloudflared.exe and system PATH). " +
                "Install cloudflared or place cloudflared.exe in the bin/ folder."
            );
        }

        const localUrl = `http://127.0.0.1:${localPort}`;
        console.log(`[tunnel] starting Cloudflare Quick Tunnel -> ${localUrl}`);
        console.log(`[tunnel] binary: ${bin}`);

        const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", localUrl], {
            cwd: this.kitRoot,
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.child = child;

        return await new Promise((resolve, reject) => {
            let settled = false;
            const recentLogs = [];
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                this.stop();
                reject(new Error(`Quick Tunnel timed out after ${timeoutMs}ms. Recent logs:\n${recentLogs.slice(-10).join("\n")}`));
            }, timeoutMs);

            const onData = (chunk) => {
                const text = chunk.toString("utf8");
                for (const line of text.split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    recentLogs.push(trimmed);
                    if (recentLogs.length > 40)
                        recentLogs.shift();

                    const match = trimmed.match(TRYCLOUDFLARE_RE);
                    if (match && !settled) {
                        settled = true;
                        clearTimeout(timer);
                        this.publicUrl = match[0];
                        console.log(`[tunnel] Quick Tunnel ready: ${this.publicUrl}`);
                        resolve(this.publicUrl);
                    }
                }
            };

            child.stdout.on("data", onData);
            child.stderr.on("data", onData);
            child.once("error", (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
            child.once("exit", (code) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error(`cloudflared exited early (code=${code}). Logs:\n${recentLogs.slice(-10).join("\n")}`));
                }
                else {
                    console.warn(`[tunnel] cloudflared exited (code=${code})`);
                }
            });
        });
    }

    stop() {
        if (this.child && !this.child.killed && this.child.pid) {
            try {
                if (process.platform === "win32") {
                    execSync(`taskkill /PID ${this.child.pid} /T /F`, { stdio: "ignore" });
                }
                else {
                    this.child.kill("SIGTERM");
                }
            }
            catch {
                // already exited
            }
        }
        this.child = null;
    }
}
