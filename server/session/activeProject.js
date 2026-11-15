import { ensureSocketForProject, refreshJoinedProject, disconnectActive } from "../api/socket.js";
import { flattenTree, isTrackChangesOnForUser } from "../api/projectTypes.js";
import { logger } from "../util/logger.js";
import { getIdentity } from "./identity.js";
import { clearDocCache, deleteDocFromCache } from "./docCache.js";
let active = null;
const BUCKET_KEYS = ["folders", "docs", "fileRefs"];

/**
 * Maintains in-memory synchronization of Overleaf's `rootFolder` tree and flattened
 * `entities` cache after REST mutations or real-time Socket.IO tree events, eliminating
 * blocking re-join calls on already-joined sockets.
 */
export class ProjectTreeMutator {
    ensureFolderShape(folder) {
        if (!Array.isArray(folder.folders))
            folder.folders = [];
        if (!Array.isArray(folder.docs))
            folder.docs = [];
        if (!Array.isArray(folder.fileRefs))
            folder.fileRefs = [];
        return folder;
    }

    findFolder(folder, folderId) {
        if (!folder)
            return null;
        this.ensureFolderShape(folder);
        if (!folderId || String(folder._id) === String(folderId))
            return folder;
        for (const sub of folder.folders) {
            const hit = this.findFolder(sub, folderId);
            if (hit)
                return hit;
        }
        return null;
    }

    findEntityLocation(folder, entityId) {
        if (!folder)
            return null;
        this.ensureFolderShape(folder);
        for (const key of BUCKET_KEYS) {
            const arr = folder[key];
            const idx = arr.findIndex((item) => String(item._id) === String(entityId));
            if (idx >= 0) {
                return { parent: folder, bucketKey: key, index: idx, item: arr[idx] };
            }
        }
        for (const sub of folder.folders) {
            const nested = this.findEntityLocation(sub, entityId);
            if (nested)
                return nested;
        }
        return null;
    }

    rebuild(ap) {
        const root = ap?.project?.rootFolder?.[0];
        if (!root)
            return ap;
        this.ensureFolderShape(root);
        ap.entities = flattenTree(root);
        ap.rootDocPath = ap.rootDocId
            ? ap.entities.find((e) => e.kind === "doc" && e.id === ap.rootDocId)?.path
            : undefined;
        return ap;
    }

    addEntity(ap, parentFolderId, bucketKey, entity) {
        const root = ap?.project?.rootFolder?.[0];
        if (!root || !entity?._id)
            return false;
        const parent = this.findFolder(root, parentFolderId) ?? root;
        this.ensureFolderShape(parent);
        const normalized = bucketKey === "folders"
            ? this.ensureFolderShape({ _id: entity._id, name: entity.name, folders: entity.folders ?? [], docs: entity.docs ?? [], fileRefs: entity.fileRefs ?? [] })
            : { ...entity };
        const bucket = parent[bucketKey];
        const existingIdx = bucket.findIndex((x) => String(x._id) === String(entity._id));
        if (existingIdx >= 0) {
            bucket[existingIdx] = bucketKey === "folders"
                ? { ...bucket[existingIdx], name: normalized.name }
                : { ...bucket[existingIdx], ...normalized };
        }
        else {
            bucket.push(normalized);
        }
        this.rebuild(ap);
        logger.debug(`tree sync add (${bucketKey}): '${normalized.name}' id=${normalized._id} parent=${parent._id}`);
        return true;
    }

    removeEntity(ap, entityId) {
        const root = ap?.project?.rootFolder?.[0];
        if (!root || !entityId)
            return false;
        const loc = this.findEntityLocation(root, entityId);
        if (!loc)
            return false;
        loc.parent[loc.bucketKey].splice(loc.index, 1);
        this.rebuild(ap);
        logger.debug(`tree sync remove (${loc.bucketKey}): id=${entityId}`);
        return true;
    }

    renameEntity(ap, entityId, newName) {
        const root = ap?.project?.rootFolder?.[0];
        if (!root || !entityId)
            return false;
        const loc = this.findEntityLocation(root, entityId);
        if (!loc)
            return false;
        loc.item.name = newName;
        this.rebuild(ap);
        logger.debug(`tree sync rename (${loc.bucketKey}): id=${entityId} -> '${newName}'`);
        return true;
    }

    moveEntity(ap, entityId, destFolderId) {
        const root = ap?.project?.rootFolder?.[0];
        if (!root || !entityId)
            return false;
        const loc = this.findEntityLocation(root, entityId);
        if (!loc)
            return false;
        const dest = this.findFolder(root, destFolderId) ?? root;
        if (String(loc.parent._id) === String(dest._id))
            return false;
        loc.parent[loc.bucketKey].splice(loc.index, 1);
        this.ensureFolderShape(dest);
        dest[loc.bucketKey].push(loc.item);
        this.rebuild(ap);
        logger.debug(`tree sync move (${loc.bucketKey}): id=${entityId} -> folder=${dest._id}`);
        return true;
    }
}

export const treeMutator = new ProjectTreeMutator();

function attachSocketTreeListeners(socket, projectId) {
    if (!socket || socket.__treeListenersAttached)
        return;
    socket.__treeListenersAttached = true;
    socket.on("reciveNewFolder", ([parentFolderId, folder]) => {
        if (active?.projectId === projectId && folder)
            treeMutator.addEntity(active, parentFolderId, "folders", folder);
    });
    socket.on("reciveNewDoc", ([parentFolderId, doc]) => {
        if (active?.projectId === projectId && doc)
            treeMutator.addEntity(active, parentFolderId, "docs", doc);
    });
    socket.on("reciveNewFile", ([parentFolderId, file]) => {
        if (active?.projectId === projectId && file)
            treeMutator.addEntity(active, parentFolderId, "fileRefs", file);
    });
    socket.on("removeEntity", ([entityId]) => {
        if (active?.projectId === projectId && entityId) {
            treeMutator.removeEntity(active, entityId);
            deleteDocFromCache(entityId);
        }
    });
    socket.on("reciveEntityRename", ([entityId, newName]) => {
        if (active?.projectId === projectId && entityId && newName)
            treeMutator.renameEntity(active, entityId, newName);
    });
    socket.on("reciveEntityMove", ([entityId, destFolderId]) => {
        if (active?.projectId === projectId && entityId)
            treeMutator.moveEntity(active, entityId, destFolderId);
    });
}
export function setLastCompile(result) {
    if (active)
        active.lastCompile = result;
}
export function getActiveProject() {
    return active;
}
/**
 * Decides which project a tool call acts on. A gateway may run one server per
 * MCP session, so every project tool accepts an explicit `project_id`. Reads
 * with a different id may switch the active project, but they must never
 * silently retarget writes: a write without `project_id` only proceeds on the
 * project the agent last confirmed — via open_project or a write naming it.
 * Re-opening that project ourselves is not an option: open() clears the doc
 * cache, dropping the stale-read baseline edit_file relies on.
 */
export class ProjectSelector {
    session;
    writeTarget = null;
    constructor(session) {
        this.session = session;
    }
    /** open_project: switch and confirm as the write target. */
    async select(projectId) {
        const ap = await this.session.open(projectId);
        this.writeTarget = ap.projectId;
        return ap;
    }
    /** Throws only when opening an explicitly requested project fails. */
    async resolve(projectId, access) {
        const current = this.session.getActiveProject();
        if (!projectId) {
            if (!current) {
                return { ok: false, error: "No project is open in this session. Pass project_id from list_projects or open_project, or call open_project in the same session." };
            }
            if (access === "write" && current.projectId !== this.writeTarget) {
                return {
                    ok: false,
                    error: `Active project changed to "${current.name}" (${current.projectId}) by a read. ` +
                        "Pass project_id, or call open_project, to confirm where this edit should go.",
                };
            }
            return { ok: true, ap: current };
        }
        const ap = current?.projectId === projectId ? current : await this.session.open(projectId);
        if (access === "write")
            this.writeTarget = ap.projectId;
        return { ok: true, ap, switchedFrom: current && current !== ap ? current : undefined };
    }
}
export const projectSelector = new ProjectSelector({ getActiveProject, open });
async function buildActiveProjectState(projectId, joinedProject) {
    const root = joinedProject.rootFolder?.[0];
    const entities = root ? flattenTree(root) : [];
    const identity = await getIdentity();
    const trackChangesOnForMe = isTrackChangesOnForUser(joinedProject, identity.userId);
    const rootDocId = joinedProject.rootDoc_id;
    const rootDocPath = rootDocId ? entities.find((e) => e.kind === "doc" && e.id === rootDocId)?.path : undefined;
    return {
        projectId,
        name: joinedProject.name ?? "(unnamed)",
        project: joinedProject,
        entities,
        trackChangesOnForMe,
        rootDocId,
        rootDocPath,
        lastCompile: active?.projectId === projectId ? active.lastCompile : undefined,
    };
}
export async function open(projectId) {
    const { socket, joinedProject } = await ensureSocketForProject(projectId);
    if (!joinedProject) {
        throw new Error("joinProject did not return a project entity");
    }
    attachSocketTreeListeners(socket, projectId);
    clearDocCache();
    active = await buildActiveProjectState(projectId, joinedProject);
    return active;
}
export async function refreshTree(projectId) {
    const targetId = projectId ?? active?.projectId;
    if (!targetId) {
        throw new Error("No active project to refresh");
    }
    const { socket, joinedProject } = await refreshJoinedProject(targetId);
    if (!joinedProject) {
        throw new Error("refreshJoinedProject did not return a project entity");
    }
    attachSocketTreeListeners(socket, targetId);
    active = await buildActiveProjectState(targetId, joinedProject);
    return active;
}
export function syncTreeAddFolder(projectId, parentFolderId, folderObj) {
    if (!active || active.projectId !== projectId)
        return false;
    return treeMutator.addEntity(active, parentFolderId, "folders", folderObj);
}
export function syncTreeAddDoc(projectId, parentFolderId, docObj) {
    if (!active || active.projectId !== projectId)
        return false;
    return treeMutator.addEntity(active, parentFolderId, "docs", docObj);
}
export function syncTreeAddFile(projectId, parentFolderId, fileObj) {
    if (!active || active.projectId !== projectId)
        return false;
    return treeMutator.addEntity(active, parentFolderId, "fileRefs", fileObj);
}
export function syncTreeRemoveEntity(projectId, entityId) {
    if (!active || active.projectId !== projectId)
        return false;
    return treeMutator.removeEntity(active, entityId);
}
export function syncTreeRenameEntity(projectId, entityId, newName) {
    if (!active || active.projectId !== projectId)
        return false;
    return treeMutator.renameEntity(active, entityId, newName);
}
export function syncTreeMoveEntity(projectId, entityId, destFolderId) {
    if (!active || active.projectId !== projectId)
        return false;
    return treeMutator.moveEntity(active, entityId, destFolderId);
}
export function getRootFolderId(ap) {
    return ap.project?.rootFolder?.[0]?._id;
}
export function close() {
    disconnectActive();
    clearDocCache();
    active = null;
}
export function findByPath(path) {
    if (!active)
        return undefined;
    const normalized = path.replace(/^\/+/, "");
    return active.entities.find((e) => e.path === normalized);
}
export function docPathById(ap) {
    const m = new Map();
    for (const e of ap.entities)
        if (e.kind === "doc")
            m.set(e.id, e.path);
    return m;
}
//# sourceMappingURL=activeProject.js.map