import crypto from "node:crypto";
import { asJson, expectOk, olGet, olPostJson } from "../api/http.js";
import { applyOtUpdate, joinDoc } from "../api/socket.js";
import { resolveDocForEdit } from "../ot/editPipeline.js";
import { updateDoc } from "../session/docCache.js";
import { findAllIndices, lineOf } from "../tools/findAndReplace.js";
import { logger } from "../util/logger.js";

/**
 * Encapsulates Overleaf review-panel comment thread discovery, anchoring,
 * replies, and state transitions, supporting both single and batched operations.
 */
export class CommentService {
    generateThreadId() {
        const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
        const rand = crypto.randomBytes(8).toString("hex");
        return `${ts}${rand}`;
    }

    formatUser(user) {
        if (!user)
            return undefined;
        return `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || undefined;
    }

    async fetchThreadDocMap(projectId) {
        const ranges = await asJson(await olGet(`project/${projectId}/ranges`), "GET /ranges");
        const map = new Map();
        for (const docRange of ranges) {
            for (const c of docRange.ranges?.comments ?? []) {
                if (c?.op?.t)
                    map.set(c.op.t, docRange.id);
            }
        }
        return map;
    }

    async lookupThreadDocId(projectId, threadId) {
        const map = await this.fetchThreadDocMap(projectId);
        const docId = map.get(threadId);
        if (!docId) {
            throw new Error(`Thread '${threadId}' is not anchored in any doc of this project. Check the id with list_comments.`);
        }
        return docId;
    }

    async fetchThreadsEnriched(projectId, docPaths, opts = {}) {
        const [threadsRes, rangesRes] = await Promise.all([
            olGet(`project/${projectId}/threads`),
            olGet(`project/${projectId}/ranges`),
        ]);
        const threads = await asJson(threadsRes, "GET /threads");
        const ranges = await asJson(rangesRes, "GET /ranges");
        const threadAnchors = new Map();
        for (const docRange of ranges) {
            for (const c of docRange.ranges?.comments ?? []) {
                threadAnchors.set(c.op.t, { doc_id: docRange.id, p: c.op.p, c: c.op.c });
            }
        }
        const out = [];
        for (const [threadId, thread] of Object.entries(threads)) {
            const anchor = threadAnchors.get(threadId);
            const messages = thread.messages ?? [];
            const first = messages[0];
            const last = messages[messages.length - 1];
            const entry = {
                thread_id: threadId,
                doc_id: anchor?.doc_id,
                doc_path: anchor?.doc_id ? docPaths.get(anchor.doc_id) : undefined,
                quoted_text: anchor?.c,
                position: anchor?.p,
                resolved: Boolean(thread.resolved),
                message_count: messages.length,
                first_author: this.formatUser(first?.user),
                last_updated: last?.timestamp ?? first?.timestamp,
                preview: last?.content ? last.content.slice(0, 120) : undefined,
            };
            if (opts.full) {
                entry.messages = messages.map((m) => ({
                    sender: this.formatUser(m.user),
                    timestamp: m.timestamp,
                    content: m.content,
                }));
            }
            out.push(entry);
        }
        out.sort((a, b) => (b.last_updated ?? 0) - (a.last_updated ?? 0));
        return out;
    }

    async postThreadMessage(projectId, threadId, content, docId) {
        let res;
        if (docId) {
            res = await olPostJson(`project/${projectId}/doc/${docId}/thread/${threadId}/messages`, { content });
            if (res.status === 404 || res.status === 405) {
                res = await olPostJson(`project/${projectId}/thread/${threadId}/messages`, { content });
            }
        }
        else {
            res = await olPostJson(`project/${projectId}/thread/${threadId}/messages`, { content });
        }
        await expectOk(res, `POST thread/${threadId}/messages`);
    }

    async setThreadState(projectId, threadId, action, docId, cachedDocMap) {
        let resolvedDocId = docId ?? cachedDocMap?.get(threadId);
        if (!resolvedDocId) {
            resolvedDocId = await this.lookupThreadDocId(projectId, threadId);
            cachedDocMap?.set(threadId, resolvedDocId);
        }
        const res = await olPostJson(`project/${projectId}/doc/${resolvedDocId}/thread/${threadId}/${action}`, {});
        await expectOk(res, `POST /doc/${resolvedDocId}/thread/${threadId}/${action}`);
        return resolvedDocId;
    }

    locateQuote(text, docPath, quote, occurrence) {
        const indices = findAllIndices(text, quote);
        if (indices.length === 0) {
            throw new Error(`\`quote\` not found in '${docPath}'. Check exact text or re-call read_file.`);
        }
        if (indices.length > 1 && occurrence === undefined) {
            const sample = indices.slice(0, 8).map((pos, i) => {
                const { line, col, lineText } = lineOf(text, pos);
                return `  [${i + 1}] line ${line}:${col}  ${lineText.trim().slice(0, 100)}`;
            }).join("\n");
            throw new Error(`\`quote\` matched ${indices.length} times in '${docPath}'. Pass \`occurrence\` (1..${indices.length}) or extend \`quote\`.\n${sample}`);
        }
        const pickIdx = (occurrence ?? 1) - 1;
        if (pickIdx < 0 || pickIdx >= indices.length) {
            throw new Error(`occurrence=${occurrence} out of range (1..${indices.length}) in '${docPath}'.`);
        }
        return indices[pickIdx];
    }

    async anchorAndPostOnDoc(ap, entity, docState, item) {
        const pos = this.locateQuote(docState.text, entity.path, item.quote, item.occurrence);
        const threadId = this.generateThreadId();
        logger.info(`add_comment anchoring thread=${threadId} doc=${entity.path} pos=${pos}`);
        await applyOtUpdate(entity.id, {
            doc: entity.id,
            op: [{ p: pos, c: item.quote, t: threadId }],
            v: docState.version,
        });
        docState.version += 1;
        updateDoc(entity.id, docState.text, docState.version);
        await this.postThreadMessage(ap.projectId, threadId, item.content, entity.id);
        return {
            thread_id: threadId,
            doc_id: entity.id,
            path: entity.path,
            position: pos,
            quote: item.quote,
            content_length: item.content.length,
        };
    }

    async addComment(ap, item) {
        const resolved = resolveDocForEdit(item.path);
        if (!resolved.ok) {
            throw new Error(resolved.response.content?.[0]?.text ?? `Cannot resolve doc '${item.path}'`);
        }
        const { entity } = resolved.doc;
        const doc = await joinDoc(entity.id);
        const docState = { text: doc.docLines.join("\n"), version: doc.version };
        updateDoc(entity.id, docState.text, docState.version);
        return await this.anchorAndPostOnDoc(ap, entity, docState, item);
    }

    async batchAddComments(ap, items) {
        const results = new Array(items.length);
        const groups = new Map();
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const resolved = resolveDocForEdit(item.path);
            if (!resolved.ok) {
                results[i] = {
                    index: i,
                    path: item.path,
                    ok: false,
                    error: resolved.response.content?.[0]?.text ?? `Cannot resolve doc '${item.path}'`,
                };
                continue;
            }
            const { entity } = resolved.doc;
            let group = groups.get(entity.id);
            if (!group) {
                group = { entity, items: [] };
                groups.set(entity.id, group);
            }
            group.items.push({ index: i, item });
        }

        for (const group of groups.values()) {
            const { entity, items: groupItems } = group;
            let docState;
            try {
                const doc = await joinDoc(entity.id);
                docState = { text: doc.docLines.join("\n"), version: doc.version };
                updateDoc(entity.id, docState.text, docState.version);
            }
            catch (joinErr) {
                const msg = joinErr instanceof Error ? joinErr.message : String(joinErr);
                for (const entry of groupItems) {
                    results[entry.index] = { index: entry.index, path: entity.path, ok: false, error: msg };
                }
                continue;
            }

            for (const { index, item } of groupItems) {
                try {
                    const out = await this.anchorAndPostOnDoc(ap, entity, docState, item);
                    results[index] = { index, ok: true, ...out };
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.warn(`batch_add_comments item[${index}] failed: ${msg}`);
                    results[index] = { index, path: entity.path, ok: false, error: msg };
                }
            }
        }

        const succeeded = results.filter((r) => r?.ok).length;
        return {
            total: items.length,
            succeeded,
            failed: items.length - succeeded,
            results,
        };
    }

    async batchReplyComments(ap, items) {
        const needsLookup = items.some((it) => it.resolve && !it.doc_id);
        const docMap = needsLookup ? await this.fetchThreadDocMap(ap.projectId) : undefined;
        const results = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            try {
                await this.postThreadMessage(ap.projectId, item.thread_id, item.content, item.doc_id);
                let resolvedDocId = item.doc_id;
                let didResolve = false;
                if (item.resolve) {
                    resolvedDocId = await this.setThreadState(ap.projectId, item.thread_id, "resolve", item.doc_id, docMap);
                    didResolve = true;
                }
                results.push({
                    index: i,
                    thread_id: item.thread_id,
                    ok: true,
                    replied: true,
                    resolved: didResolve,
                    ...(resolvedDocId ? { doc_id: resolvedDocId } : {}),
                    content_length: item.content.length,
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`batch_reply_comments item[${i}] (${item.thread_id}) failed: ${msg}`);
                results.push({ index: i, thread_id: item.thread_id, ok: false, error: msg });
            }
        }
        const succeeded = results.filter((r) => r.ok).length;
        return {
            total: items.length,
            succeeded,
            failed: items.length - succeeded,
            results,
        };
    }

    async batchSetThreadStates(ap, threadIds, action) {
        const docMap = await this.fetchThreadDocMap(ap.projectId);
        const results = [];
        for (let i = 0; i < threadIds.length; i++) {
            const threadId = threadIds[i];
            try {
                const docId = await this.setThreadState(ap.projectId, threadId, action, undefined, docMap);
                results.push({
                    index: i,
                    thread_id: threadId,
                    doc_id: docId,
                    resolved: action === "resolve",
                    ok: true,
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`batch_${action}_comments item[${i}] (${threadId}) failed: ${msg}`);
                results.push({ index: i, thread_id: threadId, ok: false, error: msg });
            }
        }
        const succeeded = results.filter((r) => r.ok).length;
        return {
            action,
            total: threadIds.length,
            succeeded,
            failed: threadIds.length - succeeded,
            results,
        };
    }
}

export const commentService = new CommentService();
