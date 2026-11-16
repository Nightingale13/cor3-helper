// Settings determine whether a cached warning still describes auto-send.
export function mercenaryWarning(settings, warning, recovery) {
    if (!settings?.enabled) {
        if (settings?.disabledReason === 'stash_full') return {
            message: 'Stash is full — auto-send mercenary disabled. Clear stash and re-enable auto-send to resume.'
        };
        if (settings?.disabledReason === 'insufficient_credits') return {
            message: 'Insufficient credits — auto-send mercenary disabled. Earn more credits and re-enable auto-send to resume.', danger: true
        };
        return null;
    }
    if (recovery) return { message: recovery.message || 'Waiting for a game response. Retrying automatically.' };
    return warning ? { message: warning } : null;
}
