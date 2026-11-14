import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { artifactStore } from "../storage/ArtifactStore.js";
import { logger } from "../util/logger.js";
import { compileService } from "./CompileService.js";

const execFileAsync = promisify(execFile);

/**
 * Compiles (or reuses latest compile), fetches output.pdf, renders selected
 * pages into PNG images (pdftoppm primary, PyMuPDF fallback), extracts optional
 * page text, and publishes an HTTP preview bundle + MCP image content blocks.
 */
export class PdfPreviewService {
    parsePageSpec(spec, totalPages, maxPages = 5) {
        const cap = Math.max(1, Math.min(maxPages, 8));
        if (!spec || spec.trim().toLowerCase() === "all") {
            const count = Math.min(totalPages, cap);
            return Array.from({ length: count }, (_, i) => i + 1);
        }
        const selected = new Set();
        for (const rawPart of spec.split(",")) {
            const part = rawPart.trim();
            if (!part)
                continue;
            const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
            if (range) {
                const start = Math.max(1, Number(range[1]));
                const end = Math.min(totalPages, Number(range[2]));
                for (let p = start; p <= end && selected.size < cap; p++) {
                    selected.add(p);
                }
            }
            else if (/^\d+$/.test(part)) {
                const p = Number(part);
                if (p >= 1 && p <= totalPages && selected.size < cap) {
                    selected.add(p);
                }
            }
            else {
                throw new Error(`Invalid page specification '${part}'. Use e.g. '1-3' or '1,2,4'.`);
            }
        }
        const arr = [...selected].sort((a, b) => a - b);
        if (arr.length === 0) {
            throw new Error(`Requested pages '${spec}' are outside valid range 1..${totalPages}.`);
        }
        return arr;
    }

    async getPdfInfoWithPoppler(pdfPath) {
        const { stdout } = await execFileAsync("pdfinfo", [pdfPath], { timeout: 15_000 });
        const pagesMatch = stdout.match(/^Pages:\s*(\d+)/m);
        const sizeMatch = stdout.match(/^Page size:\s*(.+)$/m);
        return {
            totalPages: pagesMatch ? Number(pagesMatch[1]) : 1,
            pageSize: sizeMatch ? sizeMatch[1].trim() : undefined,
        };
    }

    async extractTextWithPoppler(pdfPath, pageNumbers) {
        const texts = [];
        for (const pageNum of pageNumbers) {
            const { stdout } = await execFileAsync(
                "pdftotext",
                ["-f", String(pageNum), "-l", String(pageNum), "-enc", "UTF-8", pdfPath, "-"],
                { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
            );
            texts.push({ page: pageNum, text: stdout });
        }
        return texts;
    }

    async renderWithPoppler(pdfPath, outDir, pageNumbers, dpi) {
        const rendered = [];
        for (const pageNum of pageNumbers) {
            const prefix = path.join(outDir, `p${pageNum}`);
            await execFileAsync(
                "pdftoppm",
                ["-png", "-r", String(dpi), "-f", String(pageNum), "-l", String(pageNum), "-singlefile", pdfPath, prefix],
                { timeout: 30_000 }
            );
            const pngPath = `${prefix}.png`;
            const buf = await fs.readFile(pngPath);
            rendered.push({ page: pageNum, buffer: buf });
        }
        return rendered;
    }

    async runPyMuPdf(pdfPath, outDir, pageNumbers, dpi, includeText) {
        const script = [
            "import json, sys, os",
            "import pymupdf",
            "pdf_path, out_dir, pages_arg, dpi, want_text = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5] == '1'",
            "doc = pymupdf.open(pdf_path)",
            "total = len(doc)",
            "if pages_arg == 'probe':",
            "    print(json.dumps({'total_pages': total, 'pages': []}))",
            "    sys.exit(0)",
            "pages_json = json.loads(pages_arg)",
            "zoom = dpi / 72.0",
            "mat = pymupdf.Matrix(zoom, zoom)",
            "out_pages = []",
            "for p in pages_json:",
            "    if p < 1 or p > total: continue",
            "    page = doc[p - 1]",
            "    pix = page.get_pixmap(matrix=mat, alpha=False)",
            "    fname = os.path.join(out_dir, f'p{p}.png')",
            "    pix.save(fname)",
            "    item = {'page': p, 'file': fname}",
            "    if want_text:",
            "        item['text'] = page.get_text('text')",
            "    out_pages.append(item)",
            "print(json.dumps({'total_pages': total, 'pages': out_pages}))",
        ].join("\n");

        const pagesArg = pageNumbers === "probe" ? "probe" : JSON.stringify(pageNumbers ?? []);
        const { stdout } = await execFileAsync(
            "python",
            ["-c", script, pdfPath, outDir, pagesArg, String(dpi), includeText ? "1" : "0"],
            { timeout: 45_000, maxBuffer: 10 * 1024 * 1024 }
        );
        const parsed = JSON.parse(stdout);
        const pages = [];
        for (const p of parsed.pages) {
            const buf = await fs.readFile(p.file);
            pages.push({ page: p.page, buffer: buf, text: p.text });
        }
        return { totalPages: parsed.total_pages, pages };
    }

    async renderPdf(pdfBuffer, opts = {}) {
        const dpi = Math.max(72, Math.min(Number(opts.dpi) || 140, 250));
        const maxPages = Math.max(1, Math.min(Number(opts.max_pages) || 4, 8));
        const includeText = Boolean(opts.include_text);
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "overleaf-preview-"));
        const pdfPath = path.join(tmpDir, "output.pdf");

        try {
            await fs.writeFile(pdfPath, pdfBuffer);
            let totalPages = 1;
            let pageSize;
            let pageImages = [];
            let pageTexts = [];
            let renderer = "none";

            try {
                const info = await this.getPdfInfoWithPoppler(pdfPath);
                totalPages = info.totalPages;
                pageSize = info.pageSize;
                const pageNumbers = this.parsePageSpec(opts.pages, totalPages, maxPages);
                pageImages = await this.renderWithPoppler(pdfPath, tmpDir, pageNumbers, dpi);
                renderer = "pdftoppm";
                if (includeText) {
                    try {
                        pageTexts = await this.extractTextWithPoppler(pdfPath, pageNumbers);
                    }
                    catch (popplerTextErr) {
                        logger.warn("pdftotext failed, falling back to PyMuPDF", popplerTextErr?.message ?? String(popplerTextErr));
                        try {
                            const py = await this.runPyMuPdf(pdfPath, tmpDir, pageNumbers, 72, true);
                            pageTexts = py.pages.map((p) => ({ page: p.page, text: p.text ?? "" }));
                        }
                        catch (textErr) {
                            logger.warn("text extraction via PyMuPDF failed", textErr?.message ?? String(textErr));
                        }
                    }
                }
            }
            catch (popplerErr) {
                logger.warn("pdftoppm/pdfinfo unavailable or failed, falling back to PyMuPDF", popplerErr?.message ?? String(popplerErr));
                try {
                    const probe = await this.runPyMuPdf(pdfPath, tmpDir, "probe", 72, false);
                    totalPages = probe.totalPages;
                    const pageNumbers = this.parsePageSpec(opts.pages, totalPages, maxPages);
                    const pyRes = await this.runPyMuPdf(pdfPath, tmpDir, pageNumbers, dpi, includeText);
                    pageImages = pyRes.pages.map((p) => ({ page: p.page, buffer: p.buffer }));
                    pageTexts = includeText ? pyRes.pages.map((p) => ({ page: p.page, text: p.text ?? "" })) : [];
                    renderer = "pymupdf";
                }
                catch (pyErr) {
                    logger.warn("PyMuPDF fallback also unavailable", pyErr?.message ?? String(pyErr));
                }
            }

            return { totalPages, pageSize, pageImages, pageTexts, renderer };
        }
        finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    async compileAndPreview(ap, opts = {}) {
        let compileResult = ap.lastCompile;
        let compileSummary;
        let errorLines = [];

        if (!compileResult || opts.recompile !== false) {
            const compiled = await compileService.compileProject(ap, {
                root_doc: opts.root_doc,
                draft: opts.draft,
                stop_on_first_error: opts.stop_on_first_error,
            });
            compileResult = compiled.result;
            compileSummary = compiled.summary;
            errorLines = compiled.errorLines;
        }
        else {
            compileSummary = compileResult._cachedSummary ?? {
                status: compileResult.status ?? "unknown",
                built_cleanly: true,
                pdf_available: Boolean(compileResult.outputFiles?.some((f) => f.path === "output.pdf")),
                error_count: 0,
                warning_count: 0,
                first_errors: [],
                compile_time_ms: compileResult.timings?.compile,
                output_files: (compileResult.outputFiles ?? []).map((f) => f.path),
            };
            errorLines = compileResult._cachedErrorLines ?? [];
        }

        const { buffer: pdfBuffer } = await compileService.fetchOutputBuffer(compileResult, "output.pdf");
        const rendered = await this.renderPdf(pdfBuffer, {
            pages: opts.pages,
            dpi: opts.dpi,
            max_pages: opts.max_pages,
            include_text: opts.include_text,
        });

        const enrichedSummary = {
            ...compileSummary,
            total_pages: rendered.totalPages,
            page_size: rendered.pageSize,
            rendered_pages: rendered.pageImages.map((p) => p.page),
            renderer: rendered.renderer,
            pdf_bytes: pdfBuffer.length,
        };

        const bundle = await artifactStore.putPreviewBundle({
            projectId: ap.projectId,
            projectName: ap.name,
            pdfBuffer,
            pagePngs: rendered.pageImages,
            compileSummary: enrichedSummary,
            savePath: opts.save_path,
        });

        return {
            summary: {
                ...enrichedSummary,
                first_errors: errorLines.slice(0, 5),
                local_pdf_path: bundle.localPdfPath,
                download_url: bundle.downloadUrl,
                preview_url: bundle.previewUrl,
                expires_at: bundle.expiresAt,
            },
            pageImages: rendered.pageImages,
            pageTexts: rendered.pageTexts,
        };
    }
}

export const pdfPreviewService = new PdfPreviewService();
