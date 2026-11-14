import { z } from "zod";
import { compileService } from "../services/CompileService.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

const Schema = z.object({
    project_id: projectIdArg,
    root_doc: z
        .string()
        .optional()
        .describe("Project-relative path to use as the LaTeX root (e.g. 'main.tex'). Defaults to the project's configured root doc."),
    draft: z
        .boolean()
        .default(false)
        .describe("Draft mode — faster but uses placeholder images for figures."),
    stop_on_first_error: z
        .boolean()
        .default(false)
        .describe("Stop on the first LaTeX error instead of continuing to produce a partial PDF."),
});

export function summarizeErrors(log, maxErrorLines = 20) {
    return compileService.summarizeErrors(log, maxErrorLines);
}

export function registerCompile(server) {
    server.registerTool("compile", {
        title: "Compile the open Overleaf project",
        description: "Triggers a LaTeX compile on Overleaf's CLSI, then fetches `output.log` and returns a unified summary: " +
            "status, whether a PDF was produced, error_count (parsed `! `-prefixed log lines), warning_count, first error lines, output file list, timings. " +
            "Note: Overleaf returns status:\"success\" even when LaTeX has errors (PDF is still generated under nonstopmode). " +
            "The truthful 'did it build cleanly?' check is `error_count === 0`. " +
            "Use `read_log` for full log, `preview_pdf` to visually inspect rendered PDF pages, or `download_output` to download output.pdf / .bbl.",
        inputSchema: Schema.shape,
    }, projectTool("read", async (args, ap) => {
        try {
            const { summary, errorLines } = await compileService.compileProject(ap, {
                root_doc: args.root_doc,
                draft: args.draft,
                stop_on_first_error: args.stop_on_first_error,
            });
            const headline = summary.built_cleanly
                ? `Built cleanly. PDF produced, 0 LaTeX errors.`
                : summary.error_count > 0
                    ? `LaTeX errors detected (${summary.error_count}). ${summary.pdf_available ? "Partial PDF produced." : "No PDF."} First error: ${errorLines[0] ?? "(see read_log)"}`
                    : !summary.pdf_available
                        ? `No PDF produced. status=${summary.status}.`
                        : `Compile status: ${summary.status}.`;
            return {
                content: [
                    {
                        type: "text",
                        text: `${headline} ` +
                            (summary.compile_time_ms ? `Compile took ${summary.compile_time_ms}ms. ` : "") +
                            (summary.warning_count ? `${summary.warning_count} warning(s). ` : "") +
                            (summary.error_count > 0 ? `Use \`read_log\` for full log.` : ""),
                    },
                ],
                structuredContent: summary,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("compile failed", msg);
            return { content: [{ type: "text", text: `Compile failed: ${msg}` }], isError: true };
        }
    }));
}

export function registerReadLog(server) {
    server.registerTool("read_log", {
        title: "Read the last compile's output.log",
        description: "Returns the full LaTeX log from the most recent `compile` call. " +
            "`compile` already includes the error count + first few errors in its response — use this only when you need more context (full log, line numbers, package warnings, etc.). " +
            "The `content` array shows a summary of `!`-prefixed error lines at the top, then the log truncated to the last 8000 chars for display. " +
            "`structuredContent.log` contains the FULL untruncated log so programmatic callers can grep / parse it.",
        inputSchema: { project_id: projectIdArg },
        annotations: { readOnlyHint: true },
    }, projectTool("read", async (_args, ap) => {
        const last = ap.lastCompile;
        if (!last) {
            return { content: [{ type: "text", text: "No compile has been run for the open project yet. Call `compile` first." }], isError: true };
        }
        const logFile = last.outputFiles?.find((f) => f.path === "output.log");
        if (!logFile) {
            return { content: [{ type: "text", text: "The last compile produced no output.log (it may have failed before reaching LaTeX)." }], isError: true };
        }
        try {
            const fullLog = await compileService.fetchOutputText(last, "output.log");
            if (fullLog == null) {
                return { content: [{ type: "text", text: "No output.log available." }], isError: true };
            }
            const { errors, error_count, warnings } = compileService.summarizeErrors(fullLog, 200);
            const tail = fullLog.length > 8000 ? fullLog.slice(-8000) : fullLog;
            const errorHeader = error_count > errors.length
                ? `=== ${error_count} error line(s) (showing first ${errors.length}) ===`
                : `=== ${error_count} error line(s) ===`;
            const errorBlock = errors.length ? `${errorHeader}\n${errors.join("\n")}\n\n` : "=== no '! ' error lines ===\n\n";
            const text = errorBlock +
                (fullLog.length > 8000 ? `=== output.log (last 8000 of ${fullLog.length} chars) ===\n` : "=== output.log ===\n") +
                tail;
            return {
                content: [{ type: "text", text }],
                structuredContent: {
                    log: fullLog,
                    log_bytes: fullLog.length,
                    error_count,
                    error_lines: errors,
                    error_lines_sampled: errors.length,
                    warning_count: warnings,
                },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("read_log failed", msg);
            return { content: [{ type: "text", text: `Failed to fetch output.log: ${msg}` }], isError: true };
        }
    }));
}
