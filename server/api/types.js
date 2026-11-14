export function normalizeProject(p) {
    const id = p.id ?? p._id;
    if (!id)
        throw new Error("Project record missing id/_id");
    return {
        id,
        name: p.name ?? "(unnamed)",
        lastUpdated: p.lastUpdated,
        lastUpdatedBy: p.lastUpdatedBy
            ? { id: p.lastUpdatedBy._id, email: p.lastUpdatedBy.email }
            : undefined,
        owner: p.owner ? { id: p.owner._id, email: p.owner.email } : undefined,
        accessLevel: p.accessLevel,
        archived: p.archived,
        trashed: p.trashed,
    };
}
//# sourceMappingURL=types.js.map