import { z } from "zod";
import { pdfPreviewService } from "../services/PdfPreviewService.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

const PreviewPdfSchema = z.object({
    project_id: projectIdArg,
    recompile: z
        .boolean()
        .default(true)
        .describe("Whether to run a fresh compile before previewing (default: true). Set false to reuse the last compile."),
    pages: z
        .string()
        .default("1-2")
        .describe("Pages to render as PNG images for visual inspection, e.g. '1-2', '1,3,5', or 'all' (capped by max_pages)."),
    dpi: z
        .number()
        .int()
        .min(72)
        .max(250)
        .default(140)
        .describe("Rendering DPI for preview PNGs (default: 140). Higher DPI is sharper but larger."),
    max_pages: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(4)
        .describe("Maximum number of page images returned per call (default: 4, max: 8)."),
    include_text: z
        .boolean()
        .default(false)
        .describe("Also extract plain text from the rendered pages (useful when checking specific wording/references)."),
    root_doc: z.string().optional().describe("Optional root_doc override for compiling."),
    draft: z.boolean().default(false).describe("Draft compile mode (faster, uses placeholder figures)."),
    stop_on_first_error: z.boolean().default(false).describe("Stop compile on first LaTeX error."),
    save_path: z.string().optional().describe("Optional local path to save output.pdf."),
});

export function registerPreviewTools(server) {
    server.registerTool("preview_pdf", {
        title: "Compile and preview rendered PDF pages",
        description: "Compiles the project (unless recompile=false), fetches `output.pdf`, renders requested pages into PNG images (returned as MCP image blocks so you can visually inspect layout, figures, tables, and equations), saves `output.pdf` locally, and generates a browser preview URL + direct PDF download URL.",
        inputSchema: PreviewPdfSchema.shape,
    }, projectTool("read", async (args, ap) => {
        try {
            const res = await pdfPreviewService.compileAndPreview(ap, args);
            const s = res.summary;
            const lines = [
                `Compile status: ${s.status} | Clean build: ${s.built_cleanly} | Errors: ${s.error_count} | Warnings: ${s.warning_count}`,
                `PDF: ${s.total_pages} page(s)${s.page_size ? ` (${s.page_size})` : ""}, ${s.pdf_bytes} bytes | Rendered pages: [${s.rendered_pages.join(", ")}] via ${s.renderer}`,
                `Local PDF: ${s.local_pdf_path}`,
            ];
            if (s.preview_url)
                lines.push(`Browser Preview URL (valid until ${s.expires_at}): ${s.preview_url}`);
            if (s.download_url)
                lines.push(`Direct PDF Download URL: ${s.download_url}`);
            if (s.first_errors?.length)
                lines.push(`First errors:\n${s.first_errors.join("\n")}`);

            if (res.pageTexts.length > 0) {
                lines.push("", "=== Extracted Page Text ===");
                for (const pt of res.pageTexts) {
                    lines.push(`--- Page ${pt.page} ---`, pt.text.trim());
                }
            }

            const content = [{ type: "text", text: lines.join("\n") }];
            for (const img of res.pageImages) {
                content.push({
                    type: "image",
                    data: img.buffer.toString("base64"),
                    mimeType: "image/png",
                });
            }

            return {
                content,
                structuredContent: {
                    ...s,
                    page_texts: res.pageTexts,
                },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("preview_pdf failed", msg);
            return { content: [{ type: "text", text: `preview_pdf failed: ${msg}` }], isError: true };
        }
    }));
}
