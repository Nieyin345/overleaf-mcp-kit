import crypto from "node:crypto";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { logger } from "../util/logger.js";
import { mimeForName, sanitizeFilename } from "../util/mime.js";

/**
 * Manages temporary token-protected web artifacts (for Web AI download/preview URLs)
 * and persistent local download copies.
 *
 * Layout inside `artifactDir`:
 *   <token>/
 *     meta.json   { token, kind, projectId, createdAt, expiresAt, files: { [name]: { mimeType, sizeBytes } }, entryHtml? }
 *     <filename>  raw bytes
 */
export class ArtifactStore {
    constructor(config = loadConfig()) {
        this.artifactDir = path.resolve(config.artifactDir);
        this.downloadDir = path.resolve(config.downloadDir);
        this.publicUrl = config.publicUrl;
        this.defaultTtlMs = config.artifactTtlMs;
    }

    resolvePublicUrl() {
        const runtimeFile = path.join(this.artifactDir, ".public-url");
        if (existsSync(runtimeFile)) {
            try {
                const url = readFileSync(runtimeFile, "utf8").trim().replace(/\/+$/, "");
                if (url)
                    return url;
            }
            catch {
                // fall back to static env
            }
        }
        return this.publicUrl;
    }

    async purgeExpired() {
        try {
            const entries = await fs.readdir(this.artifactDir, { withFileTypes: true });
            const now = Date.now();
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const dir = path.join(this.artifactDir, entry.name);
                try {
                    const metaRaw = await fs.readFile(path.join(dir, "meta.json"), "utf8");
                    const meta = JSON.parse(metaRaw);
                    if (typeof meta.expiresAt === "number" && meta.expiresAt < now) {
                        await fs.rm(dir, { recursive: true, force: true });
                        logger.debug(`purged expired artifact token=${entry.name}`);
                    }
                }
                catch {
                    // Ignore malformed or concurrent writes.
                }
            }
        }
        catch (err) {
            if (err?.code !== "ENOENT") {
                logger.warn("artifact purge skipped", err?.message ?? String(err));
            }
        }
    }

    async saveLocalCopy(projectId, filename, buffer, savePath) {
        const safeName = sanitizeFilename(filename);
        const dest = savePath
            ? path.resolve(savePath)
            : path.join(this.downloadDir, sanitizeFilename(projectId || "project"), safeName);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buffer);
        logger.info(`saved local download: ${dest} (${buffer.length} bytes)`);
        return dest;
    }

    async putFile({ projectId, filename, buffer, mimeType, kind = "file", savePath, ttlMs }) {
        await this.purgeExpired();
        const safeName = sanitizeFilename(filename);
        const token = crypto.randomBytes(24).toString("hex");
        const bundleDir = path.join(this.artifactDir, token);
        await fs.mkdir(bundleDir, { recursive: true });

        const resolvedMime = mimeType ?? mimeForName(safeName);
        const now = Date.now();
        const expiresAt = now + (ttlMs ?? this.defaultTtlMs);
        await fs.writeFile(path.join(bundleDir, safeName), buffer);

        const meta = {
            token,
            kind,
            projectId,
            primaryFile: safeName,
            createdAt: now,
            expiresAt,
            files: {
                [safeName]: { mimeType: resolvedMime, sizeBytes: buffer.length },
            },
        };
        await fs.writeFile(path.join(bundleDir, "meta.json"), JSON.stringify(meta, null, 2));

        const localPath = await this.saveLocalCopy(projectId, safeName, buffer, savePath);
        const activePublicUrl = this.resolvePublicUrl();
        const downloadUrl = activePublicUrl
            ? `${activePublicUrl}/artifacts/${token}/${encodeURIComponent(safeName)}`
            : undefined;

        logger.info(`artifact stored token=${token.slice(0, 8)}... file=${safeName} size=${buffer.length}`);
        return {
            token,
            filename: safeName,
            mimeType: resolvedMime,
            sizeBytes: buffer.length,
            localPath,
            downloadUrl,
            expiresAt: new Date(expiresAt).toISOString(),
        };
    }

    async putPreviewBundle({ projectId, projectName, pdfBuffer, pagePngs, compileSummary, savePath, ttlMs }) {
        await this.purgeExpired();
        const token = crypto.randomBytes(24).toString("hex");
        const bundleDir = path.join(this.artifactDir, token);
        await fs.mkdir(bundleDir, { recursive: true });

        const files = {};
        const now = Date.now();
        const expiresAt = now + (ttlMs ?? this.defaultTtlMs);

        await fs.writeFile(path.join(bundleDir, "output.pdf"), pdfBuffer);
        files["output.pdf"] = { mimeType: "application/pdf", sizeBytes: pdfBuffer.length };

        const pageFiles = [];
        for (const page of pagePngs) {
            const fname = `page-${page.page}.png`;
            await fs.writeFile(path.join(bundleDir, fname), page.buffer);
            files[fname] = { mimeType: "image/png", sizeBytes: page.buffer.length };
            pageFiles.push({ page: page.page, filename: fname });
        }

        const html = this.buildPreviewHtml({
            token,
            projectName,
            compileSummary,
            pageFiles,
            totalPages: compileSummary.total_pages,
        });
        await fs.writeFile(path.join(bundleDir, "preview.html"), html, "utf8");
        files["preview.html"] = { mimeType: "text/html; charset=utf-8", sizeBytes: Buffer.byteLength(html, "utf8") };

        const meta = {
            token,
            kind: "preview",
            projectId,
            primaryFile: "output.pdf",
            entryHtml: "preview.html",
            createdAt: now,
            expiresAt,
            files,
        };
        await fs.writeFile(path.join(bundleDir, "meta.json"), JSON.stringify(meta, null, 2));

        const localPdfPath = await this.saveLocalCopy(projectId, "output.pdf", pdfBuffer, savePath);
        const activePublicUrl = this.resolvePublicUrl();
        const downloadUrl = activePublicUrl
            ? `${activePublicUrl}/artifacts/${token}/output.pdf`
            : undefined;
        const previewUrl = activePublicUrl
            ? `${activePublicUrl}/preview/${token}`
            : undefined;

        logger.info(`preview bundle stored token=${token.slice(0, 8)}... pages=${pageFiles.length} pdfBytes=${pdfBuffer.length}`);
        return {
            token,
            localPdfPath,
            downloadUrl,
            previewUrl,
            expiresAt: new Date(expiresAt).toISOString(),
        };
    }

    buildPreviewHtml({ token, projectName, compileSummary, pageFiles, totalPages }) {
        const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
        const imagesHtml = pageFiles.length
            ? pageFiles.map((p) => `<section class="page-card"><div class="page-label">Page ${p.page} / ${totalPages ?? "?"}</div><img src="/artifacts/${token}/${esc(p.filename)}" alt="Page ${p.page}" loading="lazy" /></section>`).join("\n")
            : `<section class="page-card"><div class="page-label">Embedded PDF Preview (${esc(totalPages ?? "?")} page(s))</div><iframe src="/artifacts/${token}/output.pdf" title="PDF Preview" style="width:100%;height:82vh;border:none;border-radius:8px;background:#fff;"></iframe></section>`;

        const errorsHtml = compileSummary.first_errors?.length
            ? `<details class="err-box" open><summary>LaTeX Errors (${compileSummary.error_count})</summary><pre>${esc(compileSummary.first_errors.join("\n"))}</pre></details>`
            : "";

        return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Overleaf Compile Preview - ${esc(projectName)}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
    .header { max-width: 980px; margin: 0 auto 20px; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 18px 22px; display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; }
    .meta h1 { margin: 0 0 6px; font-size: 18px; }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; font-size: 13px; color: #94a3b8; }
    .badge { background: #0f172a; border: 1px solid #334155; padding: 3px 10px; border-radius: 999px; }
    .badge.ok { border-color: #22c55e; color: #4ade80; }
    .badge.warn { border-color: #f59e0b; color: #fbbf24; }
    .badge.err { border-color: #ef4444; color: #f87171; }
    .btn { display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 10px 16px; border-radius: 8px; font-weight: 600; font-size: 14px; }
    .btn:hover { background: #1d4ed8; }
    .err-box { max-width: 980px; margin: 0 auto 18px; background: #450a0a; border: 1px solid #991b1b; border-radius: 10px; padding: 12px 16px; }
    .err-box pre { margin: 8px 0 0; white-space: pre-wrap; font-size: 12px; color: #fecaca; }
    .pages { max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
    .page-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 14px; }
    .page-label { font-size: 13px; color: #94a3b8; margin-bottom: 10px; }
    .page-card img { width: 100%; height: auto; display: block; border-radius: 6px; background: #fff; }
    .empty-note { text-align: center; padding: 40px; color: #94a3b8; }
  </style>
</head>
<body>
  <header class="header">
    <div class="meta">
      <h1>${esc(projectName)} — Compile Preview</h1>
      <div class="badges">
        <span class="badge ${compileSummary.error_count === 0 ? "ok" : "err"}">Errors: ${compileSummary.error_count}</span>
        <span class="badge ${compileSummary.warning_count > 0 ? "warn" : ""}">Warnings: ${compileSummary.warning_count}</span>
        <span class="badge">Pages: ${esc(totalPages ?? "?")}</span>
        ${compileSummary.compile_time_ms ? `<span class="badge">${compileSummary.compile_time_ms}ms</span>` : ""}
      </div>
    </div>
    <div>
      <a class="btn" href="/artifacts/${token}/output.pdf" download="output.pdf">Download output.pdf</a>
    </div>
  </header>
  ${errorsHtml}
  <main class="pages">
    ${imagesHtml}
  </main>
</body>
</html>`;
    }
}

export const artifactStore = new ArtifactStore();
