// Local request IDs cancel only unsent work. They are not server correlation IDs.
const controls = new Map();
function controlFor(id) {
    for (const [key, control] of controls) if (control.expiresAt < Date.now()) controls.delete(key);
    if (!controls.has(id)) controls.set(id, { cancelled: false, expiresAt: Date.now() + 120000 });
    return controls.get(id);
}
export function requestOptions(requestId) {
    if (typeof requestId !== 'string' || !requestId) return {};
    const control = controlFor(requestId);
    return { requestId, cancelled: () => control.cancelled,
        onReject: error => window.postMessage({ type: 'COR3_REQUEST_ERROR', requestId, error }, '*') };
}
export function cancelRequest(requestId) {
    if (typeof requestId === 'string' && requestId) controlFor(requestId).cancelled = true;
}
