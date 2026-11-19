// These are observations from the open game, not a server-deployment checker.
export function recordGameVersion(kind, value) {
    if (!['web', 'system', 'patch'].includes(kind) || value == null || String(value).trim() === '') return;
    const version = String(value);
    const session = window.__cor3VersionSession ||= { startedAt: Date.now(), initial: {}, current: {}, observedAt: {} };
    session.initial[kind] ??= version;
    session.current[kind] = version;
    session.observedAt[kind] = Date.now();
    const field = { web: '__cor3WebVersion', system: '__cor3SystemVersion', patch: '__cor3PatchVersion' }[kind];
    window[field] = version;
    window.postMessage({ type: { web: 'COR3_WEB_VERSION', system: 'COR3_SYSTEM_VERSION', patch: 'COR3_PATCH_VERSION' }[kind], version }, '*');
    repostGameVersions();
}

export function repostGameVersions() {
    if (window.__cor3VersionSession) window.postMessage({ type: 'COR3_GAME_VERSION_SNAPSHOT',
        session: { ...window.__cor3VersionSession, initial: { ...window.__cor3VersionSession.initial },
            current: { ...window.__cor3VersionSession.current }, observedAt: { ...window.__cor3VersionSession.observedAt } } }, '*');
}
