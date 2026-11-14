import { joinDoc } from "../api/socket.js";
const docs = new Map();
export async function ensureDocLoaded(docId) {
    const cached = docs.get(docId);
    if (cached)
        return cached;
    const r = await joinDoc(docId);
    const entry = { docId, text: r.docLines.join("\n"), version: r.version };
    docs.set(docId, entry);
    return entry;
}
export function updateDoc(docId, newText, newVersion) {
    docs.set(docId, { docId, text: newText, version: newVersion });
}
export function deleteDocFromCache(docId) {
    docs.delete(docId);
}
export function clearDocCache() {
    docs.clear();
}
//# sourceMappingURL=docCache.js.map