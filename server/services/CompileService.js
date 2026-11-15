import { asJson, expectOk, olGet, olGetBuffer, olPostJson } from "../api/http.js";
import { setLastCompile } from "../session/activeProject.js";
import { logger } from "../util/logger.js";

/**
 * Shared CLSI compile, log parsing, and output-file retrieval service.
 */
export class CompileService {
    summarizeErrors(log, maxErrorLines = 20) {
        if (!log)
            return { errors: [], error_count: 0, warnings: 0 };
        const errors = [];
        let warnings = 0;
        for (const line of log.split("\n")) {
            if (/^! /.test(line))
                errors.push(line.trim());
            else if (/warning/i.test(line))
                warnings++;
        }
        return { errors: errors.slice(0, maxErrorLines), error_count: errors.length, warnings };
    }

    buildOutputUrl(file, lastCompile) {
        const params = new URLSearchParams();
        if (lastCompile.clsiServerId)
            params.set("clsiserverid", lastCompile.clsiServerId);
        if (lastCompile.compileGroup)
            params.set("compileGroup", lastCompile.compileGroup);
        const base = file.url.replace(/^\/+/, "");
        const sep = base.includes("?") ? "&" : "?";
        const qs = params.toString();
        return qs ? `${base}${sep}${qs}` : base;
    }

    async fetchOutputText(lastCompile, targetPath) {
        const file = lastCompile.outputFiles?.find((f) => f.path === targetPath);
        if (!file)
            return undefined;
        const urlPath = this.buildOutputUrl(file, lastCompile);
        const res = await olGet(urlPath);
        await expectOk(res, `GET ${urlPath}`);
        return await res.text();
    }

    async fetchOutputBuffer(lastCompile, targetPath) {
        const file = lastCompile.outputFiles?.find((f) => f.path === targetPath);
        if (!file) {
            const available = (lastCompile.outputFiles ?? []).map((f) => f.path).join(", ") || "(none)";
            throw new Error(`Compile output '${targetPath}' not found. Available outputs: ${available}`);
        }
        const urlPath = this.buildOutputUrl(file, lastCompile);
        const { buffer, contentType } = await olGetBuffer(urlPath, `GET ${urlPath}`);
        return { buffer, contentType, file };
    }

    async compileProject(ap, opts = {}) {
        const requestedRoot = typeof opts.root_doc === "string" ? opts.root_doc.trim() : "";
        const resolvedRootDoc = requestedRoot || ap.rootDocPath || undefined;
        const body = {
            check: "silent",
            draft: Boolean(opts.draft),
            incrementalCompilesEnabled: true,
            stopOnFirstError: Boolean(opts.stop_on_first_error),
            ...(resolvedRootDoc ? { rootResourcePath: resolvedRootDoc } : {}),
        };
        logger.info(`compile start project=${ap.projectId} draft=${body.draft} root_doc=${resolvedRootDoc ?? "(server-default)"}`);
        const res = await olPostJson(`project/${ap.projectId}/compile?auto_compile=true`, body, {}, { idempotent: true });
        const result = await asJson(res, `POST project/${ap.projectId}/compile`);
        setLastCompile(result);

        const pdf = result.outputFiles?.find((f) => f.path === "output.pdf");
        const logFile = result.outputFiles?.find((f) => f.path === "output.log");
        let errorCount = 0;
        let warningCount = 0;
        let errorLines = [];
        let logBytes = 0;
        if (logFile) {
            try {
                const log = await this.fetchOutputText(result, "output.log");
                if (log) {
                    logBytes = log.length;
                    const summarized = this.summarizeErrors(log);
                    errorLines = summarized.errors;
                    errorCount = summarized.error_count;
                    warningCount = summarized.warnings;
                }
            }
            catch (logErr) {
                logger.warn("compile: log fetch failed; not fatal", logErr instanceof Error ? logErr.message : logErr);
            }
        }

        const summary = {
            status: result.status ?? "unknown",
            built_cleanly: errorCount === 0 && Boolean(pdf),
            pdf_available: Boolean(pdf),
            error_count: errorCount,
            warning_count: warningCount,
            first_errors: errorLines.slice(0, 5),
            log_bytes: logBytes,
            compile_time_ms: result.timings?.compile,
            total_time_ms: result.timings?.compileE2E,
            output_files: (result.outputFiles ?? []).map((f) => f.path),
        };
        result._cachedSummary = summary;
        result._cachedErrorLines = errorLines;
        logger.info(`compile done project=${ap.projectId} status=${summary.status} errors=${errorCount} pdf=${summary.pdf_available}`);
        return { result, summary, errorLines };
    }
}

export const compileService = new CompileService();
