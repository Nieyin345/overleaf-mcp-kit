import { createReadStream, promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const TOKEN_RE = /^[a-f0-9]{48}$/;

/**
 * Handles HTTP requests for temporary tokenized preview pages and artifact downloads.
 */
export class ArtifactHttpHandler {
    constructor(artifactDir) {
        this.artifactDir = path.resolve(artifactDir);
    }

    async tryHandle(req, res) {
        const method = req.method ?? "GET";
        if (method !== "GET" && method !== "HEAD")
            return false;

        const parsedUrl = new URL(req.url ?? "/", "http://localhost");
        const pathname = parsedUrl.pathname;

        const previewMatch = pathname.match(/^\/preview\/([^/]+)\/?$/);
        if (previewMatch) {
            await this.serveArtifactFile(req, res, previewMatch[1], "preview.html", false);
            return true;
        }

        const fileMatch = pathname.match(/^\/artifacts\/([^/]+)\/([^/]+)$/);
        if (fileMatch) {
            const filename = decodeURIComponent(fileMatch[2]);
            const forceDownload = parsedUrl.searchParams.get("download") === "1";
            await this.serveArtifactFile(req, res, fileMatch[1], filename, forceDownload);
            return true;
        }

        if (pathname.startsWith("/artifacts/") || pathname.startsWith("/preview/")) {
            this.sendText(res, 404, "Not found");
            return true;
        }

        return false;
    }

    async serveArtifactFile(req, res, token, filename, forceDownload) {
        if (!TOKEN_RE.test(token)) {
            this.sendText(res, 400, "Invalid artifact token");
            return;
        }

        const bundleDir = path.join(this.artifactDir, token);
        const metaPath = path.join(bundleDir, "meta.json");
        let meta;
        try {
            meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
        }
        catch {
            this.sendText(res, 404, "Artifact not found or expired");
            return;
        }

        if (typeof meta.expiresAt === "number" && Date.now() > meta.expiresAt) {
            await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
            this.sendText(res, 410, "Artifact link has expired");
            return;
        }

        const fileEntry = meta.files && Object.prototype.hasOwnProperty.call(meta.files, filename)
            ? meta.files[filename]
            : null;
        if (!fileEntry) {
            this.sendText(res, 404, "Requested file not found in artifact bundle");
            return;
        }

        const targetPath = path.resolve(bundleDir, filename);
        if (!targetPath.startsWith(bundleDir + path.sep)) {
            this.sendText(res, 403, "Forbidden path");
            return;
        }

        try {
            const stat = await fs.stat(targetPath);
            const inlineAllowed = !forceDownload && (
                fileEntry.mimeType.startsWith("text/html") ||
                fileEntry.mimeType.startsWith("image/") ||
                fileEntry.mimeType === "application/pdf"
            );
            const disposition = inlineAllowed ? "inline" : "attachment";
            const safeAscii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
            res.writeHead(200, {
                "Content-Type": fileEntry.mimeType,
                "Content-Length": String(stat.size),
                "Content-Disposition": `${disposition}; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            });
            if (req.method === "HEAD") {
                res.end();
                return;
            }
            console.log(`   📎 [文件服务] ${filename} (${stat.size} B)  token=${token.slice(0, 8)}…`);
            createReadStream(targetPath).pipe(res);
        }
        catch {
            this.sendText(res, 404, "Artifact file missing on disk");
        }
    }

    sendText(res, status, message) {
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(message);
    }
}

/**
 * Front-door HTTP server listening on the public gateway port:
 * serves `/artifacts/*` and `/preview/*` directly, and transparently reverse-proxies
 * `/mcp`, `/sse`, and all other traffic (including SSE & WS upgrades) to internal mcp-proxy.
 */
export class GatewayServer {
    constructor({ port, host = "0.0.0.0", upstreamHost = "127.0.0.1", upstreamPort, artifactDir }) {
        this.port = port;
        this.host = host;
        this.upstreamHost = upstreamHost;
        this.upstreamPort = upstreamPort;
        this.artifactHandler = new ArtifactHttpHandler(artifactDir);
        this.server = null;
    }

    static formatTimestamp() {
        const d = new Date();
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    }

    static extractRpcLabel(rawBody) {
        if (!rawBody) return "";
        try {
            const parsed = JSON.parse(rawBody);
            const first = Array.isArray(parsed) ? parsed[0] : parsed;
            if (!first || typeof first.method !== "string") return "";
            if (first.method === "tools/call" && typeof first.params?.name === "string") {
                return ` [${first.method}:${first.params.name}]`;
            }
            return ` [${first.method}]`;
        }
        catch {
            return "";
        }
    }

    static logHttp(method, reqPath, status, ms, extra = "") {
        const ts = GatewayServer.formatTimestamp();
        const isWellKnown404 = status === 404 && reqPath.startsWith("/.well-known/");
        const isStateless405 = status === 405 && (method === "GET" || method === "DELETE") && reqPath.startsWith("/mcp");
        let badge = "\x1b[90m🌐";
        if (isWellKnown404 || isStateless405) {
            badge = "\x1b[90mℹ️ ";
        }
        else if (status >= 400) {
            badge = "\x1b[31m⚠️";
        }
        console.log(`\x1b[90m${ts}\x1b[0m ${badge} [HTTP] ${method} ${reqPath}${extra} → ${status} (${ms}ms)\x1b[0m`);
    }

    /**
     * Handles HTTP probe methods that mcp-proxy omits (`HEAD /mcp`, `GET /mcp`
     * without session ID -> 405 per MCP Streamable HTTP spec, and `/healthz`).
     */
    handleMcpProbe(req, res) {
        const method = req.method || "GET";
        const parsed = new URL(req.url || "/", "http://localhost");
        const pathname = parsed.pathname;

        const corsHeaders = {
            "Access-Control-Allow-Origin": req.headers.origin || "*",
            "Access-Control-Allow-Methods": "GET, POST, HEAD, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Mcp-Session-Id, Last-Event-ID, MCP-Protocol-Version",
            "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
        };

        if (method === "HEAD" && (pathname === "/mcp" || pathname === "/sse" || pathname === "/" || pathname === "/healthz")) {
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "MCP-Protocol-Version": "2025-06-18",
                "Allow": "GET, POST, HEAD, DELETE, OPTIONS",
                ...corsHeaders,
            });
            res.end();
            GatewayServer.logHttp(method, req.url || pathname, 200, 0);
            return true;
        }

        if (method === "GET" && (pathname === "/" || pathname === "/healthz")) {
            const body = JSON.stringify({ ok: true, service: "overleaf-mcp", endpoints: ["/mcp", "/sse"] });
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "MCP-Protocol-Version": "2025-06-18",
                ...corsHeaders,
            });
            res.end(body);
            GatewayServer.logHttp(method, req.url || pathname, 200, 0);
            return true;
        }

        if (method === "GET" && pathname === "/mcp" && !req.headers["mcp-session-id"]) {
            const body = JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Method Not Allowed: establish a session via POST /mcp first." },
                id: null,
            });
            res.writeHead(405, {
                "Allow": "POST, HEAD, DELETE, OPTIONS",
                "Content-Type": "application/json; charset=utf-8",
                "MCP-Protocol-Version": "2025-06-18",
                ...corsHeaders,
            });
            res.end(body);
            GatewayServer.logHttp(method, req.url || pathname, 405, 0);
            return true;
        }

        return false;
    }

    async start() {
        this.server = http.createServer(async (req, res) => {
            try {
                const handled = await this.artifactHandler.tryHandle(req, res);
                if (handled)
                    return;
            }
            catch (err) {
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                    res.end(`Artifact handler error: ${err?.message ?? String(err)}`);
                }
                return;
            }
            if (this.handleMcpProbe(req, res))
                return;
            this.proxyHttp(req, res);
        });

        // Allow long-lived SSE streams and slow LaTeX compile calls.
        this.server.requestTimeout = 0;
        this.server.headersTimeout = 60_000;

        this.server.on("upgrade", (req, socket, head) => {
            this.proxyUpgrade(req, socket, head);
        });

        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.port, this.host, () => resolve());
        });
    }

    proxyHttp(req, res) {
        const startedAt = Date.now();
        const method = req.method || "GET";
        const reqPath = req.url || "/";
        const headers = { ...req.headers };
        // Support both `Authorization: Bearer <key>` (common in local Agents & ChatGPT)
        // and `x-api-key: <key>` (required natively by mcp-proxy).
        if (!headers["x-api-key"] && typeof headers["authorization"] === "string") {
            const bearer = headers["authorization"].match(/^Bearer\s+(.+)$/i);
            if (bearer) {
                headers["x-api-key"] = bearer[1].trim();
            }
        }

        // Non-blocking peek of small JSON-RPC request bodies so console logs show
        // exact MCP methods (initialize, tools/list, tools/call:...) in real time.
        let rpcLabel = "";
        const shouldPeekRpc = method === "POST"
            && reqPath.startsWith("/mcp")
            && String(headers["content-type"] || "").includes("application/json");
        if (shouldPeekRpc) {
            const peekChunks = [];
            let peekBytes = 0;
            let overflow = false;
            req.on("data", (chunk) => {
                if (overflow) return;
                peekBytes += chunk.length;
                if (peekBytes > 16_384) {
                    overflow = true;
                    peekChunks.length = 0;
                    return;
                }
                peekChunks.push(chunk);
            });
            req.on("end", () => {
                if (!overflow && peekChunks.length > 0) {
                    rpcLabel = GatewayServer.extractRpcLabel(Buffer.concat(peekChunks).toString("utf8"));
                }
            });
        }

        const proxyReq = http.request({
            hostname: this.upstreamHost,
            port: this.upstreamPort,
            path: req.url,
            method: req.method,
            headers,
        }, (proxyRes) => {
            const status = proxyRes.statusCode ?? 502;
            const ms = Date.now() - startedAt;
            GatewayServer.logHttp(method, reqPath, status, ms, rpcLabel);
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);

            const isUnexpectedMcpError = status >= 400
                && status !== 405
                && !reqPath.startsWith("/.well-known/");
            if (isUnexpectedMcpError) {
                const errChunks = [];
                let errBytes = 0;
                proxyRes.on("data", (chunk) => {
                    if (errBytes < 512) {
                        errChunks.push(chunk);
                        errBytes += chunk.length;
                    }
                });
                proxyRes.on("end", () => {
                    const snippet = Buffer.concat(errChunks).toString("utf8").replace(/\s+/g, " ").trim().slice(0, 200);
                    if (snippet) {
                        console.log(`\x1b[90m   └─ ⚠️ ${status} 响应详情: ${snippet}\x1b[0m`);
                    }
                });
            }
            proxyRes.pipe(res);
        });

        proxyReq.on("error", (err) => {
            if (!res.headersSent) {
                res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(`Upstream mcp-proxy unavailable: ${err.message}`);
            }
            else {
                res.destroy();
            }
        });

        req.on("aborted", () => proxyReq.destroy());
        res.on("close", () => {
            if (!res.writableEnded)
                proxyReq.destroy();
        });
        req.pipe(proxyReq);
    }

    proxyUpgrade(req, clientSocket, head) {
        const upstreamSocket = net.connect(this.upstreamPort, this.upstreamHost, () => {
            const headers = Object.entries(req.headers)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
                .join("\r\n");
            upstreamSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
            if (head?.length)
                upstreamSocket.write(head);
            upstreamSocket.pipe(clientSocket);
            clientSocket.pipe(upstreamSocket);
        });
        upstreamSocket.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstreamSocket.destroy());
    }

    async stop() {
        if (!this.server)
            return;
        await new Promise((resolve) => this.server.close(() => resolve()));
        this.server = null;
    }
}
