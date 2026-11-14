// Concurrency safeguards for OT edits. Both helpers re-`joinDoc` the doc and
// hand the fresh state back to the caller; cache syncing is the caller's job
// so that on failure we don't write potentially-wrong state.
//
// Why these exist: the in-process docCache makes each MCP server instance
// believe it knows the current version, but parallel agents and any open
// Overleaf web editor bump the server's version independently. When our
// `applyOtUpdate` arrives with a stale `v`, the server silently OT-transforms
// our ops against the missed updates — sometimes producing a no-op while
// still acking success. Without verification we'd happily report
// `replacements: 1` for an edit that had zero visible effect.
import { joinDoc } from "../api/socket.js";
// Re-fetch and compare to the cached version. Use before `applyOtUpdate` when
// `strict_version: true` is set so we fail fast on a stale baseline instead
// of letting the server transform our ops in surprising ways.
export async function checkBaseline(docId, cachedVersion) {
    const fresh = await joinDoc(docId);
    return {
        stale: fresh.version !== cachedVersion,
        serverVersion: fresh.version,
        serverText: fresh.docLines.join("\n"),
    };
}
// Re-fetch after `applyOtUpdate` and report whether the edit landed as we
// predicted. The caller decides whether to fail loudly or warn based on the
// flags.
export async function verifyEdit(docId, preEditText, expectedText, expectedVersion) {
    const fresh = await joinDoc(docId);
    const serverText = fresh.docLines.join("\n");
    return {
        serverVersion: fresh.version,
        serverText,
        silentNoOp: serverText === preEditText,
        matchesExpected: serverText === expectedText,
        hadConcurrentWritesAfter: fresh.version > expectedVersion,
    };
}
//# sourceMappingURL=verify.js.map