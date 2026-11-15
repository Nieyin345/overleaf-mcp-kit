import { z } from "zod";
import { asJson, olGet } from "../api/http.js";
import { commentService } from "../services/CommentService.js";
import { docPathById } from "../session/activeProject.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

const ListSchema = z.object({
    project_id: projectIdArg,
    include_resolved: z
        .boolean()
        .default(false)
        .describe("Include already-resolved threads (default: false — show open threads only)."),
    path_contains: z.string().optional().describe("Filter to threads anchored in docs whose path contains this substring."),
    thread_ids: z.array(z.string().min(8)).optional().describe("Optional filter to fetch only specific thread IDs in one call."),
    full: z.boolean().default(false).describe("Include full message history per thread instead of just a preview (avoids calling read_comment_thread repeatedly)."),
});

const ThreadIdSchema = z.object({
    project_id: projectIdArg,
    thread_id: z.string().min(8).describe("The thread id, e.g. from list_comments."),
});

const ThreadStateSchema = ThreadIdSchema.extend({
    doc_id: z
        .string()
        .min(8)
        .optional()
        .describe("Id of the doc the thread is anchored in (`doc_id` from list_comments). Looked up automatically if omitted."),
});

const ReplySchema = ThreadIdSchema.extend({
    content: z.string().min(1).describe("The reply text to post in the thread."),
    resolve: z.boolean().default(false).describe("If true, also resolve the thread immediately after posting the reply."),
    doc_id: z.string().min(8).optional().describe("Optional doc_id (used when resolve=true to skip /ranges lookup)."),
});

const AddCommentItemSchema = z.object({
    path: z.string().min(1).optional().describe("Project-relative path of the doc to comment on (defaults to root doc)."),
    quote: z.string().min(1).describe("Exact substring in the doc to anchor the review comment on."),
    occurrence: z.number().int().min(1).optional().describe("1-based occurrence index if `quote` appears multiple times."),
    content: z.string().min(1).describe("Comment message text to post."),
});

const AddCommentSchema = AddCommentItemSchema.extend({
    project_id: projectIdArg,
});

const BatchAddCommentsSchema = z.object({
    project_id: projectIdArg,
    comments: z
        .array(AddCommentItemSchema)
        .min(1)
        .max(30)
        .describe("List of comments to anchor and post in a single batched call (groups per doc to minimize Socket.IO/HTTP round-trips)."),
});

const BatchReplyItemSchema = z.object({
    thread_id: z.string().min(8).describe("The thread id from list_comments."),
    content: z.string().min(1).describe("Reply text to post in the thread."),
    resolve: z.boolean().default(false).describe("If true, also resolve the thread right after replying."),
    doc_id: z.string().min(8).optional().describe("Optional doc_id from list_comments (used when resolve=true)."),
});

const BatchReplyCommentsSchema = z.object({
    project_id: projectIdArg,
    replies: z
        .array(BatchReplyItemSchema)
        .min(1)
        .max(50)
        .describe("List of comment replies (optionally resolving each thread) executed in one MCP call."),
});

const BatchResolveCommentsSchema = z.object({
    project_id: projectIdArg,
    thread_ids: z
        .array(z.string().min(8))
        .min(1)
        .max(100)
        .describe("List of thread ids from list_comments to resolve or reopen in one call."),
    action: z
        .enum(["resolve", "reopen"])
        .default("resolve")
        .describe("State transition to apply to all specified threads (default: 'resolve')."),
});

export function registerComments(server) {
    server.registerTool("list_comments", {
        title: "List review-panel comment threads",
        description: "Returns review-panel comment threads in the open project, sorted by most recently updated. " +
            "Pass `full: true` to fetch full message histories for all matching threads in ONE call instead of calling `read_comment_thread` repeatedly.",
        inputSchema: ListSchema.shape,
        annotations: { readOnlyHint: true },
    }, projectTool("read", async (args, ap) => {
        try {
            let threads = await commentService.fetchThreadsEnriched(ap.projectId, docPathById(ap), { full: args.full });
            if (!args.include_resolved)
                threads = threads.filter((t) => !t.resolved);
            if (args.path_contains) {
                const needle = args.path_contains.toLowerCase();
                threads = threads.filter((t) => (t.doc_path ?? "").toLowerCase().includes(needle));
            }
            if (args.thread_ids?.length) {
                const wanted = new Set(args.thread_ids);
                threads = threads.filter((t) => wanted.has(t.thread_id));
            }
            return {
                content: [{ type: "text", text: JSON.stringify({ count: threads.length, threads }, null, 2) }],
                structuredContent: { count: threads.length, threads },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("list_comments failed", msg);
            return { content: [{ type: "text", text: `Failed to list comments: ${msg}` }], isError: true };
        }
    }));

    server.registerTool("read_comment_thread", {
        title: "Read a single comment thread's messages",
        description: "Fetches the full message history of one thread (all replies with author + timestamp). " +
            "Tip: to read multiple threads at once, prefer `list_comments` with `full: true` (and optional `thread_ids`).",
        inputSchema: ThreadIdSchema.shape,
        annotations: { readOnlyHint: true },
    }, projectTool("read", async (args, ap) => {
        try {
            const r = await olGet(`project/${ap.projectId}/threads`);
            const all = await asJson(r, "GET /threads");
            const t = all[args.thread_id];
            if (!t) {
                return { content: [{ type: "text", text: `Thread '${args.thread_id}' not found in this project.` }], isError: true };
            }
            return {
                content: [{ type: "text", text: JSON.stringify(t, null, 2) }],
                structuredContent: { thread_id: args.thread_id, ...t },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Failed to read thread: ${msg}` }], isError: true };
        }
    }));

    server.registerTool("add_comment", {
        title: "Add a new review-panel comment thread anchored to quoted text",
        description: "Creates a new Overleaf review-panel comment anchored on `quote` in a doc, then posts `content` as its first message. " +
            "When adding 2+ comments, prefer `batch_add_comments` to minimize tool calls.",
        inputSchema: AddCommentSchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const res = await commentService.addComment(ap, args);
            return {
                content: [{ type: "text", text: `Added comment thread ${res.thread_id} on '${res.path}' at offset ${res.position}.` }],
                structuredContent: res,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("add_comment failed", msg);
            return { content: [{ type: "text", text: `Failed to add comment: ${msg}` }], isError: true };
        }
    }));

    server.registerTool("batch_add_comments", {
        title: "Batch-add multiple review-panel comments in one call",
        description: "Anchors and posts multiple review-panel comments across one or more docs in a single tool call. " +
            "Groups operations by doc so each file only joins once, isolates per-item errors, and dramatically reduces MCP round-trips.",
        inputSchema: BatchAddCommentsSchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const summary = await commentService.batchAddComments(ap, args.comments);
            const allFailed = summary.succeeded === 0;
            const lines = [`Batch add_comments: ${summary.succeeded}/${summary.total} succeeded.`];
            for (const r of summary.results) {
                lines.push(r.ok
                    ? `  [${r.index}] OK ${r.thread_id} on '${r.path}' (pos=${r.position})`
                    : `  [${r.index}] FAIL '${r.path ?? "(root)"}': ${r.error}`);
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                isError: allFailed,
                structuredContent: summary,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("batch_add_comments failed", msg);
            return { content: [{ type: "text", text: `Batch add_comments failed: ${msg}` }], isError: true };
        }
    }));

    server.registerTool("reply_comment", {
        title: "Post a reply to a comment thread",
        description: "Adds a new message to an existing comment thread (optionally resolving it with `resolve: true`). " +
            "When replying to 2+ threads, prefer `batch_reply_comments` to avoid redundant calls.",
        inputSchema: ReplySchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            await commentService.postThreadMessage(ap.projectId, args.thread_id, args.content, args.doc_id);
            let docId = args.doc_id;
            let resolved = false;
            if (args.resolve) {
                docId = await commentService.setThreadState(ap.projectId, args.thread_id, "resolve", args.doc_id);
                resolved = true;
            }
            return {
                content: [{ type: "text", text: `Posted reply (${args.content.length} chars) to thread ${args.thread_id}${resolved ? " and resolved it" : ""}.` }],
                structuredContent: {
                    thread_id: args.thread_id,
                    content_length: args.content.length,
                    resolved,
                    ...(docId ? { doc_id: docId } : {}),
                },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Failed to post reply: ${msg}` }], isError: true };
        }
    }));

    server.registerTool("batch_reply_comments", {
        title: "Batch-reply to multiple comment threads in one call",
        description: "Posts replies to multiple comment threads (and optionally marks each resolved with `resolve: true`) in a single MCP tool call. " +
            "Looks up doc IDs at most once via /ranges and reports per-thread success/failure.",
        inputSchema: BatchReplyCommentsSchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const summary = await commentService.batchReplyComments(ap, args.replies);
            const allFailed = summary.succeeded === 0;
            const lines = [`Batch reply_comments: ${summary.succeeded}/${summary.total} succeeded.`];
            for (const r of summary.results) {
                lines.push(r.ok
                    ? `  [${r.index}] OK thread ${r.thread_id} (${r.content_length} chars${r.resolved ? ", resolved" : ""})`
                    : `  [${r.index}] FAIL thread ${r.thread_id}: ${r.error}`);
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                isError: allFailed,
                structuredContent: summary,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("batch_reply_comments failed", msg);
            return { content: [{ type: "text", text: `Batch reply_comments failed: ${msg}` }], isError: true };
        }
    }));

    server.registerTool("resolve_comment", {
        title: "Resolve a comment thread",
        description: "Marks a thread as resolved. Pass `doc_id` from list_comments to skip a lookup round-trip. " +
            "When resolving 2+ threads, prefer `batch_resolve_comments`.",
        inputSchema: ThreadStateSchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const docId = await commentService.setThreadState(ap.projectId, args.thread_id, "resolve", args.doc_id);
            return {
                content: [{ type: "text", text: `Resolved thread ${args.thread_id}.` }],
                structuredContent: { thread_id: args.thread_id, doc_id: docId, resolved: true },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Failed to resolve: ${msg}` }], isError: true };
        }
    }));

    server.registerTool("reopen_comment", {
        title: "Reopen a resolved comment thread",
        description: "Reopens a previously-resolved thread. Pass `doc_id` from list_comments to skip a lookup round-trip. " +
            "To reopen multiple threads at once, use `batch_resolve_comments` with `action: 'reopen'`.",
        inputSchema: ThreadStateSchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const docId = await commentService.setThreadState(ap.projectId, args.thread_id, "reopen", args.doc_id);
            return {
                content: [{ type: "text", text: `Reopened thread ${args.thread_id}.` }],
                structuredContent: { thread_id: args.thread_id, doc_id: docId, resolved: false },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Failed to reopen: ${msg}` }], isError: true };
        }
    }));

    server.registerTool("batch_resolve_comments", {
        title: "Batch-resolve or reopen multiple comment threads in one call",
        description: "Marks multiple comment threads as resolved (or reopened with `action: 'reopen'`) in a single MCP tool call. " +
            "Fetches /ranges only once for all threads instead of N times.",
        inputSchema: BatchResolveCommentsSchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const summary = await commentService.batchSetThreadStates(ap, args.thread_ids, args.action);
            const allFailed = summary.succeeded === 0;
            const lines = [`Batch ${args.action}_comments: ${summary.succeeded}/${summary.total} succeeded.`];
            for (const r of summary.results) {
                lines.push(r.ok
                    ? `  [${r.index}] OK thread ${r.thread_id} (${args.action})`
                    : `  [${r.index}] FAIL thread ${r.thread_id}: ${r.error}`);
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                isError: allFailed,
                structuredContent: summary,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("batch_resolve_comments failed", msg);
            return { content: [{ type: "text", text: `Batch resolve_comments failed: ${msg}` }], isError: true };
        }
    }));
}
