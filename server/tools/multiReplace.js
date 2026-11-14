import { z } from "zod";
import { textToOps } from "../ot/diff.js";
import { prepareBaseline, resolveDocForEdit, submitAndVerify } from "../ot/editPipeline.js";
import { TRACK_MODES } from "../ot/trackedChanges.js";
import { logger } from "../util/logger.js";
import { findAllIndices, lineOf } from "./findAndReplace.js";
import { projectIdArg, projectTool } from "./project.js";

const EditOpSchema = z.object({
    old_string: z.string().min(1).describe("Exact substring to locate in the doc."),
    new_string: z.string().describe("Replacement text (may be empty to delete)."),
    replace_all: z.boolean().default(false).describe("Replace every occurrence of old_string instead of requiring a unique match."),
});

const Schema = z.object({
    project_id: projectIdArg,
    path: z
        .string()
        .min(1)
        .optional()
        .describe("Project-relative path of the doc to edit (defaults to root doc)."),
    edits: z
        .array(EditOpSchema)
        .min(1)
        .max(50)
        .describe("Ordered list of find-and-replace operations applied atomically in a single OT round-trip."),
    expected_version: z.number().int().optional().describe("Optional safety check against current doc version."),
    track: z.enum(TRACK_MODES).default("on").describe("Tracked-changes mode ('on' default, 'off', or 'auto')."),
    strict_version: z.boolean().default(false).describe("Re-fetch doc version before submitting to fail fast on stale baselines."),
});

export function registerMultiReplace(server) {
    server.registerTool("multi_replace", {
        title: "Batch multiple find-and-replace edits in one OT submission",
        description: "Applies an ordered array of exact `old_string -> new_string` edits to a single Overleaf doc and submits the combined diff in ONE real-time OT round-trip. " +
            "All edits are validated before sending — if any edit has 0 matches or ambiguous matches (without replace_all), nothing is sent. " +
            "Much faster and cheaper than calling `find_and_replace` N times or rewriting the entire file with `edit_file`.",
        inputSchema: Schema.shape,
    }, projectTool("write", async (args) => {
        const resolved = resolveDocForEdit(args.path);
        if (!resolved.ok)
            return resolved.response;
        const { ap, entity } = resolved.doc;

        try {
            const baseline = await prepareBaseline(entity, {
                expected_version: args.expected_version,
                strict_version: args.strict_version,
            });
            if (!baseline.ok)
                return baseline.response;

            const { cached } = baseline;
            const preEditText = cached.text;
            let working = preEditText;
            let totalReplacements = 0;
            const perEditCounts = [];

            for (let idx = 0; idx < args.edits.length; idx++) {
                const step = args.edits[idx];
                const indices = findAllIndices(working, step.old_string);
                if (indices.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: `edits[${idx}] \`old_string\` not found in '${entity.path}' (aborted before submitting any edits). Check whitespace or re-call read_file.`,
                        }],
                        isError: true,
                    };
                }
                if (indices.length > 1 && !step.replace_all) {
                    const sample = indices.slice(0, 8).map((pos) => {
                        const { line, col, lineText } = lineOf(working, pos);
                        const trimmed = lineText.trim();
                        const preview = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
                        return `  line ${line}:${col}  ${preview}`;
                    }).join("\n");
                    return {
                        content: [{
                            type: "text",
                            text: `edits[${idx}] \`old_string\` matched ${indices.length} times in '${entity.path}' (aborted before submitting). Extend \`old_string\` or set \`replace_all: true\`.\nMatches:\n${sample}`,
                        }],
                        isError: true,
                    };
                }
                if (step.replace_all) {
                    working = working.split(step.old_string).join(step.new_string);
                    totalReplacements += indices.length;
                    perEditCounts.push(indices.length);
                }
                else {
                    working = working.slice(0, indices[0]) + step.new_string + working.slice(indices[0] + step.old_string.length);
                    totalReplacements += 1;
                    perEditCounts.push(1);
                }
            }

            const ops = textToOps(preEditText, working);
            if (ops.length === 0) {
                return {
                    content: [{ type: "text", text: "No-op: resulting document is identical to current content." }],
                    structuredContent: { path: entity.path, doc_id: entity.id, version: cached.version, ops_applied: 0, replacements: 0 },
                };
            }

            const r = await submitAndVerify({
                ap,
                entity,
                cached,
                preEditText,
                expectedText: working,
                ops,
                track: args.track,
            });

            if (r.silentNoOp) {
                return {
                    content: [{
                        type: "text",
                        text: `Server acked batch OT update for '${entity.path}' but text stayed unchanged (silent no-op due to concurrent write). Cache synced to v${r.versionAfter}.`,
                    }],
                    isError: true,
                    structuredContent: {
                        path: entity.path,
                        doc_id: entity.id,
                        replacements: 0,
                        ops_applied: ops.length,
                        version_before: cached.version,
                        version_after: r.versionAfter,
                        silent_no_op: true,
                    },
                };
            }

            logger.info(`multi_replace applied ${args.edits.length} step(s) / ${totalReplacements} replacement(s) in '${entity.path}' (v${cached.version}->v${r.versionAfter})`);
            return {
                content: [{
                    type: "text",
                    text: `Applied ${args.edits.length} edit rule(s) (${totalReplacements} replacement(s), ${ops.length} OT op(s)) to '${entity.path}'. Doc version ${cached.version} -> ${r.versionAfter}. ` +
                        r.trackingNote + r.concurrentNote + r.verifySkippedNote,
                }],
                structuredContent: {
                    path: entity.path,
                    doc_id: entity.id,
                    edit_rules: args.edits.length,
                    replacements: totalReplacements,
                    per_edit_replacements: perEditCounts,
                    ops_applied: ops.length,
                    version_before: cached.version,
                    version_after: r.versionAfter,
                    tracked: r.serverWillTrack,
                    track_mode: args.track,
                    track_overridden: r.trackOverridden,
                    verified: r.v ? r.v.matchesExpected : false,
                    had_concurrent_writes_after: r.v?.hadConcurrentWritesAfter ?? false,
                },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("multi_replace failed", msg);
            return {
                content: [{ type: "text", text: `Failed to multi_replace in '${args.path ?? "(root doc)"}': ${msg}` }],
                isError: true,
            };
        }
    }));
}
