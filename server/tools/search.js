import { z } from "zod";
import { ensureDocLoaded } from "../session/docCache.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

const Schema = z.object({
    project_id: projectIdArg,
    query: z.string().min(1).describe("Search keyword or regular expression pattern."),
    is_regex: z.boolean().default(false).describe("Treat `query` as a JavaScript RegExp pattern."),
    case_sensitive: z.boolean().default(false).describe("Case-sensitive search (default: false)."),
    path_contains: z.string().optional().describe("Restrict search to docs whose project-relative path contains this substring."),
    max_results: z.number().int().min(1).max(200).default(50).describe("Maximum number of matching lines to return (default: 50)."),
    context_lines: z.number().int().min(0).max(3).default(0).describe("Optional number of surrounding lines before/after each match."),
});

function buildMatcher(query, isRegex, caseSensitive) {
    const flags = caseSensitive ? "g" : "gi";
    if (isRegex) {
        return new RegExp(query, flags);
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, flags);
}

export function registerSearchTools(server) {
    server.registerTool("search_in_project", {
        title: "Search text across all docs in the Overleaf project",
        description: "Searches across all editable text docs (.tex, .bib, .md, etc.) in the open project for a substring or regex, returning matching paths, 1-based line numbers, columns, and line snippets. Uses cached docs when available.",
        inputSchema: Schema.shape,
        annotations: { readOnlyHint: true },
    }, projectTool("read", async (args, ap) => {
        let matcher;
        try {
            matcher = buildMatcher(args.query, args.is_regex, args.case_sensitive);
        }
        catch (err) {
            return {
                content: [{ type: "text", text: `Invalid regex '${args.query}': ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }

        let docs = ap.entities.filter((e) => e.kind === "doc");
        if (args.path_contains) {
            const needle = args.path_contains.toLowerCase();
            docs = docs.filter((e) => e.path.toLowerCase().includes(needle));
        }

        const matches = [];
        let truncated = false;
        let docsSearched = 0;

        try {
            for (const docEntity of docs) {
                const loaded = await ensureDocLoaded(docEntity.id);
                docsSearched++;
                const lines = loaded.text.split("\n");
                for (let i = 0; i < lines.length; i++) {
                    const lineText = lines[i];
                    matcher.lastIndex = 0;
                    const hit = matcher.exec(lineText);
                    if (!hit)
                        continue;

                    const item = {
                        path: docEntity.path,
                        doc_id: docEntity.id,
                        line: i + 1,
                        column: hit.index + 1,
                        text: lineText.length > 240 ? `${lineText.slice(0, 237)}...` : lineText,
                    };
                    if (args.context_lines > 0) {
                        const start = Math.max(0, i - args.context_lines);
                        const end = Math.min(lines.length - 1, i + args.context_lines);
                        item.context = lines.slice(start, end + 1).map((l, off) => `${start + off + 1}: ${l}`);
                    }
                    matches.push(item);
                    if (matches.length >= args.max_results) {
                        truncated = true;
                        break;
                    }
                }
                if (truncated)
                    break;
            }

            logger.info(`search_in_project query='${args.query}' docs=${docsSearched} matches=${matches.length}`);
            const textLines = matches.length === 0
                ? [`No matches for '${args.query}' across ${docsSearched} doc(s).`]
                : [
                    `Found ${matches.length}${truncated ? "+" : ""} match(es) across ${docsSearched} doc(s):`,
                    ...matches.map((m) => `${m.path}:${m.line}:${m.column}  ${m.text.trim()}`),
                ];

            return {
                content: [{ type: "text", text: textLines.join("\n") }],
                structuredContent: {
                    query: args.query,
                    docs_searched: docsSearched,
                    match_count: matches.length,
                    truncated,
                    matches,
                },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("search_in_project failed", msg);
            return { content: [{ type: "text", text: `search_in_project failed: ${msg}` }], isError: true };
        }
    }));
}
