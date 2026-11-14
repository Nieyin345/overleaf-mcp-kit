import { ensureSocketForProject, refreshJoinedProject, disconnectActive } from "../api/socket.js";
import { flattenTree, isTrackChangesOnForUser } from "../api/projectTypes.js";
import { getIdentity } from "./identity.js";
import { clearDocCache } from "./docCache.js";
let active = null;
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
    const { joinedProject } = await ensureSocketForProject(projectId);
    if (!joinedProject) {
        throw new Error("joinProject did not return a project entity");
    }
    clearDocCache();
    active = await buildActiveProjectState(projectId, joinedProject);
    return active;
}
export async function refreshTree(projectId) {
    const targetId = projectId ?? active?.projectId;
    if (!targetId) {
        throw new Error("No active project to refresh");
    }
    const { joinedProject } = await refreshJoinedProject(targetId);
    if (!joinedProject) {
        throw new Error("refreshJoinedProject did not return a project entity");
    }
    active = await buildActiveProjectState(targetId, joinedProject);
    return active;
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