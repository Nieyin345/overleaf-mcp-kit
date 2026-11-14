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
        const proxyReq = http.request({
            hostname: this.upstreamHost,
            port: this.upstreamPort,
            path: req.url,
            method: req.method,
            headers,
        }, (proxyRes) => {
            const status = proxyRes.statusCode ?? 502;
            const ms = Date.now() - startedAt;
            const d = new Date();
            const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
            const badge = status >= 400 ? "\x1b[31m⚠️" : "\x1b[90m🌐";
            console.log(`\x1b[90m${ts}\x1b[0m ${badge} [HTTP] ${method} ${reqPath} → ${status} (${ms}ms)\x1b[0m`);
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
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
