import { olGetBuffer } from "../api/http.js";
import { joinDoc } from "../api/socket.js";
import { findByPath } from "../session/activeProject.js";
import { updateDoc } from "../session/docCache.js";
import { artifactStore } from "../storage/ArtifactStore.js";
import { logger } from "../util/logger.js";
import { looksLikeUtf8Text, mimeForName, sanitizeFilename } from "../util/mime.js";
import { compileService } from "./CompileService.js";

/**
 * Handles downloading individual project files, full project ZIP archives,
 * and CLSI compilation artifacts (output.pdf, .bbl, .aux, .synctex.gz, etc.).
 */
export class DownloadService {
    async downloadFile(ap, targetPath, opts = {}) {
        const resolvedPath = targetPath ?? ap.rootDocPath;
        if (!resolvedPath) {
            throw new Error("No path provided and the project has no configured root doc.");
        }
        const entity = findByPath(resolvedPath);
        if (!entity) {
            throw new Error(`Path not found in project: '${resolvedPath}'.`);
        }
        if (entity.kind === "folder") {
            throw new Error(`'${resolvedPath}' is a folder. Use download_project to export the project as a zip.`);
        }

        let buffer;
        let mimeType;
        if (entity.kind === "doc") {
            const doc = await joinDoc(entity.id);
            const text = doc.docLines.join("\n");
            updateDoc(entity.id, text, doc.version);
            buffer = Buffer.from(text, "utf8");
            mimeType = mimeForName(entity.name);
        }
        else {
            const res = await olGetBuffer(`project/${ap.projectId}/file/${entity.id}`, `GET project/${ap.projectId}/file/${entity.id}`);
            buffer = res.buffer;
            mimeType = mimeForName(entity.name);
        }

        const stored = await artifactStore.putFile({
            projectId: ap.projectId,
            filename: entity.name,
            buffer,
            mimeType,
            kind: "file",
            savePath: opts.save_path,
        });

        const includeBase64 = Boolean(opts.include_base64);
        const textPreview = opts.include_text && looksLikeUtf8Text(entity.name, buffer)
            ? buffer.toString("utf8")
            : undefined;

        logger.info(`downloadFile path=${entity.path} size=${buffer.length} url=${stored.downloadUrl ?? "(local-only)"}`);
        return {
            path: entity.path,
            kind: entity.kind,
            ...stored,
            ...(includeBase64 ? { base64: buffer.toString("base64") } : {}),
            ...(textPreview !== undefined ? { text: textPreview } : {}),
        };
    }

    async downloadProjectZip(ap, opts = {}) {
        logger.info(`downloading project zip project=${ap.projectId} (${ap.name})`);
        const { buffer } = await olGetBuffer(
            `project/${ap.projectId}/download/zip`,
            `GET project/${ap.projectId}/download/zip`
        );
        const filename = `${sanitizeFilename(ap.name || ap.projectId)}.zip`;
        const stored = await artifactStore.putFile({
            projectId: ap.projectId,
            filename,
            buffer,
            mimeType: "application/zip",
            kind: "zip",
            savePath: opts.save_path,
        });

        return {
            project_name: ap.name,
            ...stored,
        };
    }

    async downloadCompileOutput(ap, opts = {}) {
        const artifactName = opts.output_file?.trim() || "output.pdf";
        const { buffer, compileResult, compileSummary } = await compileService.resolveAndFetchOutput(ap, artifactName, {
            recompile: Boolean(opts.recompile),
            root_doc: opts.root_doc,
            draft: opts.draft,
        });

        const stored = await artifactStore.putFile({
            projectId: ap.projectId,
            filename: artifactName.split("/").pop() || "output.pdf",
            buffer,
            mimeType: mimeForName(artifactName),
            kind: "compile_output",
            savePath: opts.save_path,
        });

        const includeBase64 = Boolean(opts.include_base64);
        return {
            output_file: artifactName,
            available_outputs: (compileResult.outputFiles ?? []).map((f) => f.path),
            compile_summary: compileSummary,
            ...stored,
            ...(includeBase64 ? { base64: buffer.toString("base64") } : {}),
        };
    }
}

export const downloadService = new DownloadService();
