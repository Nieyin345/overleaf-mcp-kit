export class OverleafAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = "OverleafAuthError";
    }
}
export class OverleafApiError extends Error {
    status;
    body;
    constructor(status, body, hint) {
        super(`Overleaf API error ${status}${hint ? ` (${hint})` : ""}: ${body.slice(0, 200)}`);
        this.name = "OverleafApiError";
        this.status = status;
        this.body = body;
    }
}
//# sourceMappingURL=errors.js.map