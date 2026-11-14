export const BINARY_EXTS = new Set([
    "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "svg",
    "pdf", "eps", "ps", "ai",
    "zip", "tar", "gz", "bz2", "7z",
    "ttf", "otf", "woff", "woff2",
]);

const MIME_MAP = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
    ttf: "font/ttf",
    otf: "font/otf",
    woff: "font/woff",
    woff2: "font/woff2",
    tex: "text/x-tex; charset=utf-8",
    bib: "text/plain; charset=utf-8",
    sty: "text/plain; charset=utf-8",
    cls: "text/plain; charset=utf-8",
    log: "text/plain; charset=utf-8",
    bbl: "text/plain; charset=utf-8",
    aux: "text/plain; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
    html: "text/html; charset=utf-8",
    csv: "text/csv; charset=utf-8",
};

export function mimeForName(name) {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return MIME_MAP[ext] ?? "application/octet-stream";
}

export function looksLikeUtf8Text(name, buf) {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (BINARY_EXTS.has(ext) || buf.length === 0)
        return false;
    return buf.subarray(0, Math.min(2048, buf.length))
        .every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128);
}

export function sanitizeFilename(name) {
    const base = name.replace(/\\/g, "/").split("/").pop() || "file";
    return base.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, "_");
}

export function normalizeProjectPath(p) {
    return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}
