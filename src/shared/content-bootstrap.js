// A reconnect may inject the same bundle twice. Keep one live receiver per
// extension context, while allowing a new context after an extension reload.
export function bootstrapContent(load) {
    const previous = window.__cor3ContentBootstrap;
    try {
        if (previous?.runtime.getManifest()) return previous.promise;
    } catch { /* The previous extension context was invalidated. */ }
    const boot = { runtime: chrome.runtime, ready: false, promise: null };
    window.__cor3ContentBootstrap = boot;
    boot.promise = Promise.resolve().then(load).then(() => { boot.ready = true; }).catch(error => {
        if (window.__cor3ContentBootstrap === boot) delete window.__cor3ContentBootstrap;
        throw error;
    });
    return boot.promise;
}
