import { promises as fs } from "node:fs";
import path from "node:path";
import { asJson, expectOk, olDelete, olPostJson, olPostMultipart } from "../api/http.js";
import { applyOtUpdate, joinDoc } from "../api/socket.js";
import { textToOps } from "../ot/diff.js";
import { generateIdSeed, resolveTracking } from "../ot/trackedChanges.js";
import { findByPath, getRootFolderId, refreshTree } from "../session/activeProject.js";
import { deleteDocFromCache, updateDoc } from "../session/docCache.js";
import { logger } from "../util/logger.js";
import { looksLikeUtf8Text, mimeForName, normalizeProjectPath } from "../util/mime.js";

/**
 * Manages Overleaf project entities: folders, docs, binary file uploads,
 * deletions, renames, and moves. Keeps activeProject tree & docCache synced.
 */
export class EntityService {
    validateRelativePath(rawPath) {
        const normalized = normalizeProjectPath(rawPath);
        if (!normalized) {
            throw new Error("Path cannot be empty.");
        }
        const segments = normalized.split("/");
        if (segments.some((s) => !s || s === "." || s === "..")) {
            throw new Error(`Invalid project-relative path: '${rawPath}'`);
        }
        return { normalized, segments };
    }

    splitParentAndName(rawPath) {
        const { normalized, segments } = this.validateRelativePath(rawPath);
        const name = segments[segments.length - 1];
        const parentPath = segments.slice(0, -1).join("/");
        return { normalized, parentPath, name };
    }

    async ensureFolder(ap, folderPath, createMissing = true) {
        const rootId = getRootFolderId(ap);
        if (!rootId) {
            throw new Error("Project rootFolder id is missing; try reopening the project.");
        }
        if (!folderPath)
            return { folderId: rootId, created: [] };

        const { segments } = this.validateRelativePath(folderPath);
        let currentParentId = rootId;
        let currentPrefix = "";
        const created = [];

        for (const seg of segments) {
            currentPrefix = currentPrefix ? `${currentPrefix}/${seg}` : seg;
            const existing = ap.entities.find((e) => e.path === currentPrefix);
            if (existing) {
                if (existing.kind !== "folder") {
                    throw new Error(`Path conflict: '${currentPrefix}' exists as a ${existing.kind}, not a folder.`);
                }
                currentParentId = existing.id;
                continue;
            }
            if (!createMissing) {
                throw new Error(`Parent folder '${currentPrefix}' does not exist.`);
            }
            logger.info(`creating folder '${currentPrefix}' under parent=${currentParentId}`);
            const res = await olPostJson(`project/${ap.projectId}/folder`, {
                name: seg,
                parent_folder_id: currentParentId,
            });
            const data = await asJson(res, `POST project/${ap.projectId}/folder (${currentPrefix})`);
            const newId = data._id ?? data.id;
            if (!newId) {
                throw new Error(`Overleaf did not return folder id when creating '${currentPrefix}'`);
            }
            currentParentId = newId;
            created.push({ path: currentPrefix, id: newId });
        }

        if (created.length > 0) {
            await refreshTree(ap.projectId);
        }
        return { folderId: currentParentId, created };
    }

    async createFolder(ap, folderPath) {
        const { normalized } = this.validateRelativePath(folderPath);
        const { folderId, created } = await this.ensureFolder(ap, normalized, true);
        return { path: normalized, folder_id: folderId, created_folders: created };
    }

    async createDoc(ap, docPath, opts = {}) {
        const { normalized, parentPath, name } = this.splitParentAndName(docPath);
        const existing = findByPath(normalized);
        if (existing) {
            if (!opts.overwrite) {
                throw new Error(`Entity already exists at '${normalized}' (${existing.kind}). Pass overwrite: true or use edit_file.`);
            }
            if (existing.kind !== "doc") {
                throw new Error(`Cannot overwrite non-doc '${normalized}' (${existing.kind}) with create_doc.`);
            }
            if (opts.content !== undefined) {
                const updated = await this.writeDocContent(ap, existing.id, opts.content, opts.track ?? "off");
                return {
                    path: normalized,
                    doc_id: existing.id,
                    created: false,
                    overwritten: true,
                    version: updated.version,
                    bytes: Buffer.byteLength(opts.content, "utf8"),
                };
            }
            return { path: normalized, doc_id: existing.id, created: false, overwritten: false };
        }

        const { folderId } = await this.ensureFolder(ap, parentPath, opts.create_folders ?? true);
        logger.info(`creating doc '${normalized}' in folder=${folderId}`);
        const res = await olPostJson(`project/${ap.projectId}/doc`, {
            name,
            parent_folder_id: folderId,
        });
        const data = await asJson(res, `POST project/${ap.projectId}/doc (${normalized})`);
        const docId = data._id ?? data.id;
        if (!docId) {
            throw new Error(`Overleaf did not return doc_id when creating '${normalized}'`);
        }

        let version = 0;
        if (opts.content !== undefined && opts.content.length > 0) {
            const written = await this.writeDocContent(ap, docId, opts.content, opts.track ?? "off");
            version = written.version;
        }
        await refreshTree(ap.projectId);
        return {
            path: normalized,
            doc_id: docId,
            created: true,
            overwritten: false,
            version,
            bytes: opts.content !== undefined ? Buffer.byteLength(opts.content, "utf8") : 0,
        };
    }

    async writeDocContent(ap, docId, content, trackMode = "off") {
        const joined = await joinDoc(docId);
        const currentText = joined.docLines.join("\n");
        const ops = textToOps(currentText, content);
        if (ops.length === 0) {
            updateDoc(docId, content, joined.version);
            return { version: joined.version, ops: 0 };
        }
        const { shouldTrack } = resolveTracking(trackMode, ap.trackChangesOnForMe);
        const update = { doc: docId, op: ops, v: joined.version };
        if (shouldTrack) {
            update.meta = { tc: generateIdSeed() };
        }
        await applyOtUpdate(docId, update);
        const verified = await joinDoc(docId);
        const serverText = verified.docLines.join("\n");
        updateDoc(docId, serverText, verified.version);
        return { version: verified.version, ops: ops.length };
    }

    async resolveUploadBuffer(opts) {
        const provided = [
            opts.content_base64 !== undefined ? "content_base64" : null,
            opts.content_text !== undefined ? "content_text" : null,
            opts.local_path !== undefined ? "local_path" : null,
        ].filter(Boolean);

        if (provided.length === 0) {
            throw new Error("Provide one of `content_base64`, `content_text`, or `local_path`.");
        }
        if (provided.length > 1) {
            throw new Error(`Provide only one content source, got: ${provided.join(", ")}`);
        }

        if (opts.content_base64 !== undefined) {
            const clean = opts.content_base64.replace(/^data:[^;]+;base64,/i, "").trim();
            return { buffer: Buffer.from(clean, "base64"), sourceType: "base64" };
        }
        if (opts.content_text !== undefined) {
            return { buffer: Buffer.from(opts.content_text, "utf8"), sourceType: "text" };
        }
        const resolvedLocal = path.resolve(opts.local_path);
        const buffer = await fs.readFile(resolvedLocal);
        return { buffer, sourceType: "local_path", localPath: resolvedLocal };
    }

    async uploadFile(ap, targetPath, opts = {}) {
        const { normalized, parentPath, name } = this.splitParentAndName(targetPath);
        const { buffer, sourceType } = await this.resolveUploadBuffer(opts);
        const overwrite = opts.overwrite ?? true;
        const createFolders = opts.create_folders ?? true;

        const existing = findByPath(normalized);
        if (existing) {
            if (!overwrite) {
                throw new Error(`File already exists at '${normalized}' (${existing.kind}). Pass overwrite: true to replace it.`);
            }
            if (existing.kind === "folder") {
                throw new Error(`Target '${normalized}' is a folder; cannot overwrite a folder with a file.`);
            }
            // If overwriting an existing Overleaf text `doc` with UTF-8 text, update in-place via OT to preserve doc_id & history.
            if (existing.kind === "doc" && (sourceType === "text" || looksLikeUtf8Text(name, buffer))) {
                const text = buffer.toString("utf8");
                const written = await this.writeDocContent(ap, existing.id, text, opts.track ?? "off");
                logger.info(`upload_file updated existing doc '${normalized}' via OT (v=${written.version})`);
                return {
                    path: normalized,
                    entity_id: existing.id,
                    kind: "doc",
                    replaced: true,
                    method: "ot_update",
                    byte_count: buffer.length,
                    version: written.version,
                };
            }
            // Remove existing fileRef (or doc replaced by binary) so Overleaf doesn't keep duplicate names.
            logger.info(`upload_file removing existing ${existing.kind} '${normalized}' (${existing.id}) before upload`);
            const delRes = await olDelete(`project/${ap.projectId}/${existing.kind}/${existing.id}`);
            await expectOk(delRes, `DELETE project/${ap.projectId}/${existing.kind}/${existing.id}`);
            if (existing.kind === "doc") {
                deleteDocFromCache(existing.id);
            }
        }

        const { folderId } = await this.ensureFolder(ap, parentPath, createFolders);
        const mime = mimeForName(name);
        logger.info(`uploading '${normalized}' (${buffer.length} bytes, mime=${mime}) to folder=${folderId}`);

        const res = await olPostMultipart(
            `project/${ap.projectId}/upload?folder_id=${encodeURIComponent(folderId)}`,
            () => {
                const form = new FormData();
                form.append("name", name);
                form.append("qqfile", new Blob([buffer], { type: mime }), name);
                return form;
            }
        );
        const result = await asJson(res, `POST project/${ap.projectId}/upload (${normalized})`);
        if (result.success === false) {
            throw new Error(`Overleaf rejected upload for '${normalized}': ${JSON.stringify(result)}`);
        }

        await refreshTree(ap.projectId);
        const refreshed = findByPath(normalized);
        return {
            path: normalized,
            entity_id: refreshed?.id ?? result.entity_id,
            kind: refreshed?.kind ?? result.entity_type ?? "file",
            replaced: Boolean(existing),
            method: "multipart_upload",
            byte_count: buffer.length,
            mime_type: mime,
        };
    }

    async deleteEntity(ap, targetPath, opts = {}) {
        const { normalized } = this.validateRelativePath(targetPath);
        const entity = findByPath(normalized);
        if (!entity) {
            throw new Error(`Entity not found in project: '${normalized}'.`);
        }
        if (ap.rootDocPath && entity.path === ap.rootDocPath && !opts.force) {
            throw new Error(`Refusing to delete project root doc '${normalized}' without force: true.`);
        }

        let childDocs = [];
        if (entity.kind === "folder") {
            const prefix = `${entity.path}/`;
            const children = ap.entities.filter((e) => e.path.startsWith(prefix));
            if (children.length > 0 && !opts.recursive) {
                throw new Error(`Folder '${normalized}' is not empty (${children.length} item(s) inside). Pass recursive: true to delete it and all contents.`);
            }
            childDocs = children.filter((e) => e.kind === "doc");
        }

        logger.info(`deleting ${entity.kind} '${normalized}' (id=${entity.id})`);
        const res = await olDelete(`project/${ap.projectId}/${entity.kind}/${entity.id}`);
        await expectOk(res, `DELETE project/${ap.projectId}/${entity.kind}/${entity.id}`);

        if (entity.kind === "doc") {
            deleteDocFromCache(entity.id);
        }
        for (const d of childDocs) {
            deleteDocFromCache(d.id);
        }

        await refreshTree(ap.projectId);
        return {
            deleted: true,
            path: normalized,
            kind: entity.kind,
            entity_id: entity.id,
            children_deleted: childDocs.length,
        };
    }

    async renameEntity(ap, targetPath, newName) {
        const { normalized } = this.validateRelativePath(targetPath);
        const cleanName = normalizeProjectPath(newName);
        if (!cleanName || cleanName.includes("/")) {
            throw new Error(`new_name must be a single filename/folder name without slashes, got '${newName}'.`);
        }
        const entity = findByPath(normalized);
        if (!entity) {
            throw new Error(`Entity not found in project: '${normalized}'.`);
        }
        logger.info(`renaming ${entity.kind} '${normalized}' -> '${cleanName}'`);
        const res = await olPostJson(`project/${ap.projectId}/${entity.kind}/${entity.id}/rename`, {
            name: cleanName,
        });
        await expectOk(res, `POST project/${ap.projectId}/${entity.kind}/${entity.id}/rename`);
        await refreshTree(ap.projectId);

        const parentPrefix = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/") + 1) : "";
        return {
            renamed: true,
            kind: entity.kind,
            entity_id: entity.id,
            old_path: normalized,
            new_path: `${parentPrefix}${cleanName}`,
        };
    }

    async moveEntity(ap, targetPath, destFolderPath) {
        const { normalized } = this.validateRelativePath(targetPath);
        const entity = findByPath(normalized);
        if (!entity) {
            throw new Error(`Entity not found in project: '${normalized}'.`);
        }
        const cleanDest = normalizeProjectPath(destFolderPath ?? "");
        const { folderId } = await this.ensureFolder(ap, cleanDest, true);
        logger.info(`moving ${entity.kind} '${normalized}' -> folder='${cleanDest || "(root)"}' (${folderId})`);
        const res = await olPostJson(`project/${ap.projectId}/${entity.kind}/${entity.id}/move`, {
            folder_id: folderId,
        });
        await expectOk(res, `POST project/${ap.projectId}/${entity.kind}/${entity.id}/move`);
        await refreshTree(ap.projectId);

        return {
            moved: true,
            kind: entity.kind,
            entity_id: entity.id,
            old_path: normalized,
            new_path: cleanDest ? `${cleanDest}/${entity.name}` : entity.name,
        };
    }
}

export const entityService = new EntityService();
