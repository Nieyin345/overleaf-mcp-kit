// Shapes returned by Overleaf's joinProject / joinDoc Socket.IO events.
// Field names match what the server emits — keep raw, normalize in tools.
export function flattenTree(root, prefix = "") {
    const out = [];
    for (const folder of root.folders) {
        const path = prefix ? `${prefix}/${folder.name}` : folder.name;
        out.push({ kind: "folder", id: folder._id, path, name: folder.name, parentFolderId: root._id });
        out.push(...flattenTree(folder, path));
    }
    for (const doc of root.docs) {
        const path = prefix ? `${prefix}/${doc.name}` : doc.name;
        out.push({ kind: "doc", id: doc._id, path, name: doc.name, parentFolderId: root._id });
    }
    for (const file of root.fileRefs) {
        const path = prefix ? `${prefix}/${file.name}` : file.name;
        out.push({ kind: "file", id: file._id, path, name: file.name, parentFolderId: root._id });
    }
    return out;
}
export function isTrackChangesOnForUser(project, userId) {
    const state = project.track_changes_state ?? project.trackChangesState;
    if (state === undefined || state === null)
        return false;
    if (typeof state === "boolean")
        return state;
    if (typeof state === "object") {
        const m = state;
        if (m[userId] === true)
            return true;
        if (m["__guests__"] === true)
            return true;
        // Some Overleaf builds use the value true on key '__everyone__' or 'all'.
        if (m["__everyone__"] === true)
            return true;
    }
    return false;
}
//# sourceMappingURL=projectTypes.js.map