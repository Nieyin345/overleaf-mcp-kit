import { z } from "zod";
import { downloadService } from "../services/DownloadService.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

const DownloadFileSchema = z.object({
    project_id: projectIdArg,
    path: z.string().min(1).optional().describe("Project-relative path to download (defaults to root doc)."),
    save_path: z.string().optional().describe("Optional local destination file path on the MCP host machine."),
    include_base64: z.boolean().default(false).describe("Include base64 bytes directly in structuredContent (keep false for large files)."),
    include_text: z.boolean().default(false).describe("Include UTF-8 text preview in structuredContent if it is a text file."),
});

const DownloadProjectSchema = z.object({
    project_id: projectIdArg,
    save_path: z.string().optional().describe("Optional local destination path for the .zip archive."),
});

const DownloadOutputSchema = z.object({
    project_id: projectIdArg,
    output_file: z.string().default("output.pdf").describe("Compile artifact path, e.g. 'output.pdf', 'output.bbl', 'output.aux', 'output.synctex.gz', 'output.log'."),
    recompile: z.boolean().default(false).describe("If true (or if no compile has run yet), runs compile first before downloading."),
    root_doc: z.string().optional().describe("Optional root_doc override if triggering a compile."),
    draft: z.boolean().default(false).describe("Optional draft flag if triggering a compile."),
    save_path: z.string().optional().describe("Optional local destination path on the MCP host machine."),
    include_base64: z.boolean().default(false).describe("Include base64 payload directly in structuredContent (avoid for large PDFs)."),
});

function errResult(action, err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${action} failed`, msg);
    return { content: [{ type: "text", text: `${action} failed: ${msg}` }], isError: true };
}

export function registerDownloadTools(server) {
    server.registerTool("download_file", {
        title: "Download a project file and get a download link",
        description: "Downloads a file from Overleaf, saves a local copy, and returns a temporary tokenized HTTPS download URL (when exposed via public gateway) so Web AI users can download it directly.",
        inputSchema: DownloadFileSchema.shape,
        annotations: { readOnlyHint: true },
    }, projectTool("read", async (args, ap) => {
        try {
            const res = await downloadService.downloadFile(ap, args.path, {
                save_path: args.save_path,
                include_base64: args.include_base64,
                include_text: args.include_text,
            });
            const urlLine = res.downloadUrl ? `\nDownload URL (valid until ${res.expiresAt}): ${res.downloadUrl}` : "";
            return {
                content: [{ type: "text", text: `Downloaded '${res.path}' (${res.sizeBytes} bytes) -> ${res.localPath}${urlLine}` }],
                structuredContent: res,
            };
        }
        catch (err) {
            return errResult("download_file", err);
        }
    }));

    server.registerTool("download_project", {
        title: "Download entire Overleaf project as a ZIP archive",
        description: "Exports the entire Overleaf project source tree as a .zip file, saves it locally, and returns a temporary tokenized HTTPS download URL for Web AI.",
        inputSchema: DownloadProjectSchema.shape,
        annotations: { readOnlyHint: true },
    }, projectTool("read", async (args, ap) => {
        try {
            const res = await downloadService.downloadProjectZip(ap, { save_path: args.save_path });
            const urlLine = res.downloadUrl ? `\nDownload URL (valid until ${res.expiresAt}): ${res.downloadUrl}` : "";
            return {
                content: [{ type: "text", text: `Downloaded project ZIP '${res.filename}' (${res.sizeBytes} bytes) -> ${res.localPath}${urlLine}` }],
                structuredContent: res,
            };
        }
        catch (err) {
            return errResult("download_project", err);
        }
    }));

    server.registerTool("download_output", {
        title: "Download compiled output artifact (PDF, .bbl, .aux, etc.)",
        description: "Fetches a build artifact from Overleaf's CLSI worker (default: `output.pdf`; also supports `output.bbl`, `output.aux`, `output.synctex.gz`, etc.), saves it locally, and returns a temporary tokenized HTTPS download URL.",
        inputSchema: DownloadOutputSchema.shape,
    }, projectTool("read", async (args, ap) => {
        try {
            const res = await downloadService.downloadCompileOutput(ap, args);
            const urlLine = res.downloadUrl ? `\nDownload URL (valid until ${res.expiresAt}): ${res.downloadUrl}` : "";
            return {
                content: [{ type: "text", text: `Downloaded '${res.output_file}' (${res.sizeBytes} bytes) -> ${res.localPath}${urlLine}` }],
                structuredContent: res,
            };
        }
        catch (err) {
            return errResult("download_output", err);
        }
    }));
}
