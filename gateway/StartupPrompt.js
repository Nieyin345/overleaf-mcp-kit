import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TunnelManager } from "./TunnelManager.js";

/**
 * Interactive terminal connection-mode prompt executed when launching in a TTY console.
 * Falls back transparently to `config.json` defaults in non-interactive runs
 * (`OL_NON_INTERACTIVE=1`, piped stdin, or `PROMPT_ON_START: false`).
 */
export class StartupConfigPrompt {
    constructor(cfg = {}) {
        this.cfg = cfg;
    }

    static normalizeHostname(raw) {
        return String(raw || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    }

    static getLanIpv4Addresses(osMod) {
        const list = [];
        const nets = osMod.networkInterfaces();
        for (const entries of Object.values(nets)) {
            for (const info of entries || []) {
                if (info && info.family === "IPv4" && !info.internal) {
                    list.push(info.address);
                }
            }
        }
        return list;
    }

    resolveNonInteractive() {
        const { mode, hostname } = TunnelManager.resolveMode(this.cfg);
        const port = this.cfg.PORT === 0 || this.cfg.PORT === "0" ? 0 : (Number(this.cfg.PORT) || 8080);
        return { tunnelMode: mode, hostname, port, prompted: false };
    }

    async resolveInteractiveOrDefault() {
        if (!stdin.isTTY || this.cfg.PROMPT_ON_START === false || process.env.OL_NON_INTERACTIVE === "1") {
            return this.resolveNonInteractive();
        }

        const baseResolved = TunnelManager.resolveMode(this.cfg);
        const defaultChoice = baseResolved.mode === "custom" ? "2" : baseResolved.mode === "local" ? "3" : "1";
        const configuredPort = Number(this.cfg.PORT) > 0 ? Number(this.cfg.PORT) : 8080;

        console.log("请选择本次启动的连接方式 (直接回车选择默认 [" + defaultChoice + "]):");
        console.log("  [1] 临时公网地址  (无需域名，自动启动 Quick Tunnel 生成临时公网 URL)");
        console.log("  [2] 固定域名 / IP (终端显示本地 IP 和端口，自行到 Cloudflare Zero Trust 等配置)");
        console.log("  [3] 仅本机使用    (仅监听 127.0.0.1)");
        console.log("");

        const rl = readline.createInterface({ input: stdin, output: stdout });
        try {
            const answer = (await rl.question(`请输入选项 [1/2/3] (默认 ${defaultChoice}): `)).trim();
            const choice = answer || defaultChoice;

            if (choice === "2") {
                const portAns = (await rl.question(`请输入本地监听端口 (默认 ${configuredPort}，直接回车使用默认): `)).trim();
                let port = configuredPort;
                if (portAns) {
                    const parsed = Number(portAns);
                    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
                        port = parsed;
                    }
                    else {
                        console.log(`[WARN] 端口号无效 "${portAns}"，将使用默认端口 ${configuredPort}。`);
                    }
                }
                const defHost = baseResolved.hostname || "";
                const hostHint = defHost ? `当前: ${defHost}，直接回车沿用` : "如 overleaf.example.com，不填直接回车仅显示本地地址端口";
                const hostAns = (await rl.question(`可选：输入你配置好的固定域名 (${hostHint}): `)).trim();
                const hostname = StartupConfigPrompt.normalizeHostname(hostAns || defHost);
                return { tunnelMode: "custom", hostname, port, prompted: true };
            }

            if (choice === "3") {
                const portAns = (await rl.question(`请输入本机监听端口 (默认 ${configuredPort}，直接回车使用默认): `)).trim();
                const parsed = Number(portAns);
                const port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : configuredPort;
                return { tunnelMode: "local", hostname: "", port, prompted: true };
            }

            // Default [1]: Temporary Cloudflare Quick Tunnel (direct URL generation)
            const quickPort = this.cfg.PORT === 0 || this.cfg.PORT === "0" ? 0 : 0;
            return { tunnelMode: "quick", hostname: "", port: quickPort, prompted: true };
        }
        finally {
            rl.close();
        }
    }
}
