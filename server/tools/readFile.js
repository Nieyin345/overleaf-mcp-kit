import { z } from "zod";
import { olGet, expectOk } from "../api/http.js";
import { joinDoc } from "../api/socket.js";
import { findByPath } from "../session/activeProject.js";
import { updateDoc } from "../session/docCache.js";
import { logger } from "../util/logger.js";
import { looksLikeUtf8Text, mimeForName } from "../util/mime.js";
import { projectIdArg, projectTool } from "./project.js";

const Schema = z.object({
    project_id: projectIdArg,
    path: z
        .string()
        .min(1)
        .optional()
        .describe("Project-relative path of the file, e.g. 'main.tex' or 'chapters/intro.tex'. If omitted, defaults to the project's root doc."),
    start_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional 1-based start line for reading a slice of a large text doc (still caches full doc for edits)."),
    end_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional 1-based inclusive end line for reading a slice of a text doc."),
});

function sliceLines(lines, startLine, endLine) {
    if (startLine === undefined && endLine === undefined) {
        return { text: lines.join("\n"), sliced: false, from: 1, to: lines.length };
    }
    const from = Math.max(1, startLine ?? 1);
    const to = Math.min(lines.length, endLine ?? lines.length);
    if (from > to && lines.length > 0) {
        return { text: "", sliced: true, from, to };
    }
    return {
        text: lines.slice(from - 1, to).join("\n"),
        sliced: true,
        from,
        to,
    };
}

const BatchReadSchema = z.object({
    project_id: projectIdArg,
    paths: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe("List of project-relative file paths to read in a single tool call (ideal for inspecting multiple .tex/.bib chapters together)."),
    max_lines_per_file: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Optional max lines from start of each text file (omit to read full files)."),
});

async function readSingleEntity(ap, resolvedPath, { start_line, end_line } = {}) {
    const entity = findByPath(resolvedPath);
    if (!entity) {
        return {
            ok: false,
            error: `Path not found in project: '${resolvedPath}'. Use list_files to inspect available paths.`,
        };
    }
    if (entity.kind === "folder") {
        return { ok: false, error: `'${resolvedPath}' is a folder, not a file.` };
    }
    if (entity.kind === "doc") {
        const doc = await joinDoc(entity.id);
        const fullText = doc.docLines.join("\n");
        updateDoc(entity.id, fullText, doc.version);
        const slice = sliceLines(doc.docLines, start_line, end_line);
        const ranges = doc.ranges;
        const changeCount = Array.isArray(ranges?.changes) ? ranges.changes.length : 0;
        const commentCount = Array.isArray(ranges?.comments) ? ranges.comments.length : 0;
        return {
            ok: true,
            isBinary: false,
            text: slice.text,
            meta: {
                path: entity.path,
                doc_id: entity.id,
                kind: "doc",
                text: slice.text,
                sliced: slice.sliced,
                start_line: slice.from,
                end_line: slice.to,
                version: doc.version,
                line_count: doc.docLines.length,
                byte_count: Buffer.byteLength(fullText, "utf8"),
                has_ranges: doc.ranges !== undefined && doc.ranges !== null,
                tracked_change_count: changeCount,
                comment_count: commentCount,
                recent_changes: Array.isArray(ranges?.changes) ? ranges.changes.slice(-5) : [],
            },
        };
    }
    const res = await olGet(`project/${ap.projectId}/file/${entity.id}`);
    await expectOk(res, `GET project/${ap.projectId}/file/${entity.id}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (looksLikeUtf8Text(entity.name, buf)) {
        const fullText = buf.toString("utf8");
        const lines = fullText.split(/\r?\n/);
        const slice = sliceLines(lines, start_line, end_line);
        return {
            ok: true,
            isBinary: false,
            text: slice.text,
            meta: {
                path: entity.path,
                file_id: entity.id,
                kind: "file",
                text: slice.text,
                sliced: slice.sliced,
                start_line: slice.from,
                end_line: slice.to,
                line_count: lines.length,
                byte_count: buf.length,
                encoding: "utf8",
            },
        };
    }
    const base64 = buf.toString("base64");
    return {
        ok: true,
        isBinary: true,
        base64,
        byteCount: buf.length,
        meta: {
            path: entity.path,
            file_id: entity.id,
            kind: "file",
            base64,
            byte_count: buf.length,
            mime_type: mimeForName(entity.name),
            encoding: "base64",
        },
    };
}

export function registerReadFile(server) {
    server.registerTool("read_file", {
        title: "Read a file from the open Overleaf project",
        description: "Reads the contents of a file by project-relative path. Pass project_id to read without a prior open_project in this session. " +
            "Supports optional start_line/end_line for reading slices of large .tex files without wasting tokens. " +
            "To read 2+ files at once, prefer `read_files`.",
        inputSchema: Schema.shape,
        annotations: { readOnlyHint: true },
    }, projectTool("read", async (args, ap) => {
        const resolvedPath = args.path ?? ap.rootDocPath;
        if (!resolvedPath) {
            return { content: [{ type: "text", text: "No path provided and the project has no configured root doc. Pass a `path` from `list_files`." }], isError: true };
        }
        try {
            const res = await readSingleEntity(ap, resolvedPath, {
                start_line: args.start_line,
                end_line: args.end_line,
            });
            if (!res.ok) {
                return { content: [{ type: "text", text: res.error }], isError: true };
            }
            if (res.isBinary) {
                return {
                    content: [
                        { type: "text", text: `(binary file, ${res.byteCount} bytes, base64 below)` },
                        { type: "text", text: res.base64 },
                    ],
                    structuredContent: res.meta,
                };
            }
            return {
                content: [{ type: "text", text: res.text }],
                structuredContent: res.meta,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("read_file failed", msg);
            return { content: [{ type: "text", text: `Failed to read '${args.path}': ${msg}` }], isError: true };
        }
    }));

    server.registerTool("read_files", {
        title: "Read multiple files from the open Overleaf project in one call",
        description: "Reads multiple text/doc files in a single MCP tool call to avoid calling `read_file` repeatedly across chapters.",
        inputSchema: BatchReadSchema.shape,
        annotations: { readOnlyHint: true },
    }, projectTool("read", async (args, ap) => {
        const files = [];
        const sections = [];
        const sliceOpts = args.max_lines_per_file ? { start_line: 1, end_line: args.max_lines_per_file } : {};
        for (const p of args.paths) {
            try {
                const res = await readSingleEntity(ap, p, sliceOpts);
                if (!res.ok) {
                    files.push({ path: p, ok: false, error: res.error });
                    sections.push(`=== ${p} [ERROR] ===\n${res.error}`);
                }
                else if (res.isBinary) {
                    files.push({ ok: true, ...res.meta, base64: undefined, binary_omitted_in_text: true });
                    sections.push(`=== ${res.meta.path} (binary, ${res.byteCount} bytes, ${res.meta.mime_type}) ===`);
                }
                else {
                    files.push({ ok: true, ...res.meta });
                    const rangeInfo = res.meta.sliced ? ` [lines ${res.meta.start_line}-${res.meta.end_line} of ${res.meta.line_count}]` : "";
                    sections.push(`=== ${res.meta.path}${rangeInfo} ===\n${res.text}`);
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                files.push({ path: p, ok: false, error: msg });
                sections.push(`=== ${p} [ERROR] ===\n${msg}`);
            }
        }
        const succeeded = files.filter((f) => f.ok).length;
        return {
            content: [{ type: "text", text: sections.join("\n\n") }],
            isError: succeeded === 0,
            structuredContent: {
                total: args.paths.length,
                succeeded,
                failed: args.paths.length - succeeded,
                files,
            },
        };
    }));
}
