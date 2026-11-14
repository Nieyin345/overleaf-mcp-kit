import { z } from "zod";
import { TRACK_MODES } from "../ot/trackedChanges.js";
import { entityService } from "../services/EntityService.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

const CreateFolderSchema = z.object({
    project_id: projectIdArg,
    path: z.string().min(1).describe("Project-relative folder path to create, e.g. 'figures' or 'chapters/appendix'. Nested missing parents are created automatically."),
});

const CreateDocSchema = z.object({
    project_id: projectIdArg,
    path: z.string().min(1).describe("Project-relative doc path to create, e.g. 'chapters/methods.tex' or 'refs.bib'."),
    content: z.string().optional().describe("Optional initial UTF-8 text content to write into the new doc."),
    overwrite: z.boolean().default(false).describe("If true and a doc already exists at `path`, overwrite its content via OT."),
    create_folders: z.boolean().default(true).describe("Automatically create missing parent folders."),
    track: z.enum(TRACK_MODES).default("off").describe("Tracked-changes mode when writing content (defaults to 'off' for newly created docs)."),
});

const UploadFileSchema = z.object({
    project_id: projectIdArg,
    path: z.string().min(1).describe("Project-relative destination path, e.g. 'figures/architecture.png' or 'IEEEtran.cls'."),
    content_base64: z.string().optional().describe("Base64-encoded file payload (ideal for images, PDFs, or binary assets from Web AI). Accepts raw base64 or data URLs."),
    content_text: z.string().optional().describe("UTF-8 plain text payload (convenient for .tex, .bib, .sty, .cls, .csv)."),
    local_path: z.string().optional().describe("Local filesystem path on the machine running the MCP gateway (useful when uploading local files)."),
    overwrite: z.boolean().default(true).describe("If true (default), replaces an existing file/doc at the same path instead of creating duplicates or failing."),
    create_folders: z.boolean().default(true).describe("Automatically create missing parent folders."),
    track: z.enum(TRACK_MODES).default("off").describe("Tracked-changes mode when overwriting an existing Overleaf text doc."),
});

const DeleteEntitySchema = z.object({
    project_id: projectIdArg,
    path: z.string().min(1).describe("Project-relative path of the doc, file, or folder to delete."),
    recursive: z.boolean().default(false).describe("Required to delete a non-empty folder (deletes all items inside)."),
    force: z.boolean().default(false).describe("Required to delete the project's configured root doc (e.g. main.tex)."),
});

const RenameEntitySchema = z.object({
    project_id: projectIdArg,
    path: z.string().min(1).describe("Current project-relative path of the doc, file, or folder."),
    new_name: z.string().min(1).describe("New filename or folder name (without slashes), e.g. 'intro_v2.tex'."),
});

const MoveEntitySchema = z.object({
    project_id: projectIdArg,
    path: z.string().min(1).describe("Current project-relative path of the doc, file, or folder."),
    destination_folder: z.string().default("").describe("Target folder path, e.g. 'archive' or 'chapters/old'. Empty string moves to project root."),
});

function errResult(action, err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${action} failed`, msg);
    return { content: [{ type: "text", text: `${action} failed: ${msg}` }], isError: true };
}

export function registerEntityTools(server) {
    server.registerTool("create_folder", {
        title: "Create a folder in the Overleaf project",
        description: "Creates a folder (including any missing nested parent folders) and refreshes the cached file tree.",
        inputSchema: CreateFolderSchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const res = await entityService.createFolder(ap, args.path);
            return {
                content: [{ type: "text", text: `Folder ready at '${res.path}' (id=${res.folder_id}, created ${res.created_folders.length} new folder(s)).` }],
                structuredContent: res,
            };
        }
        catch (err) {
            return errResult("create_folder", err);
        }
    }));

    server.registerTool("create_doc", {
        title: "Create a new text doc in the Overleaf project",
        description: "Creates a new editable doc (.tex, .bib, .md, etc.) in the project, optionally creating parent folders and populating initial text content.",
        inputSchema: CreateDocSchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const res = await entityService.createDoc(ap, args.path, {
                content: args.content,
                overwrite: args.overwrite,
                create_folders: args.create_folders,
                track: args.track,
            });
            return {
                content: [{ type: "text", text: `${res.created ? "Created" : "Updated"} doc '${res.path}' (doc_id=${res.doc_id}, ${res.bytes} bytes).` }],
                structuredContent: res,
            };
        }
        catch (err) {
            return errResult("create_doc", err);
        }
    }));

    server.registerTool("upload_file", {
        title: "Upload a file (image, PDF, tex, sty, etc.) to Overleaf",
        description: "Uploads a binary or text file into the Overleaf project via Overleaf's multipart /upload endpoint (or updates an existing text doc via OT when overwriting). " +
            "Provide exactly one of `content_base64`, `content_text`, or `local_path`. Automatically creates missing parent folders.",
        inputSchema: UploadFileSchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const res = await entityService.uploadFile(ap, args.path, {
                content_base64: args.content_base64,
                content_text: args.content_text,
                local_path: args.local_path,
                overwrite: args.overwrite,
                create_folders: args.create_folders,
                track: args.track,
            });
            return {
                content: [{ type: "text", text: `${res.replaced ? "Replaced" : "Uploaded"} '${res.path}' (${res.kind}, ${res.byte_count} bytes, method=${res.method}).` }],
                structuredContent: res,
            };
        }
        catch (err) {
            return errResult("upload_file", err);
        }
    }));

    server.registerTool("delete_entity", {
        title: "Delete a doc, file, or folder in Overleaf",
        description: "Permanently deletes a doc, binary file, or folder from the Overleaf project and updates the cached file tree. " +
            "Refuses deleting the root doc unless `force: true` and refuses non-empty folders unless `recursive: true`.",
        inputSchema: DeleteEntitySchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const res = await entityService.deleteEntity(ap, args.path, {
                recursive: args.recursive,
                force: args.force,
            });
            return {
                content: [{ type: "text", text: `Deleted ${res.kind} '${res.path}' (id=${res.entity_id}).` }],
                structuredContent: res,
            };
        }
        catch (err) {
            return errResult("delete_entity", err);
        }
    }));

    server.registerTool("rename_entity", {
        title: "Rename a doc, file, or folder in Overleaf",
        description: "Renames an existing doc, file, or folder in place and refreshes the cached file tree.",
        inputSchema: RenameEntitySchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const res = await entityService.renameEntity(ap, args.path, args.new_name);
            return {
                content: [{ type: "text", text: `Renamed ${res.kind} '${res.old_path}' -> '${res.new_path}'.` }],
                structuredContent: res,
            };
        }
        catch (err) {
            return errResult("rename_entity", err);
        }
    }));

    server.registerTool("move_entity", {
        title: "Move a doc, file, or folder into another folder",
        description: "Moves an entity to `destination_folder` (creating missing folders if needed; empty string moves to root).",
        inputSchema: MoveEntitySchema.shape,
    }, projectTool("write", async (args, ap) => {
        try {
            const res = await entityService.moveEntity(ap, args.path, args.destination_folder);
            return {
                content: [{ type: "text", text: `Moved ${res.kind} '${res.old_path}' -> '${res.new_path}'.` }],
                structuredContent: res,
            };
        }
        catch (err) {
            return errResult("move_entity", err);
        }
    }));
}
