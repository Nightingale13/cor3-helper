function errorMessage(error) {
    return (error?.message || '').trim().replace(/^(?:(?:Mail claim failed|Pay and send to mail failed):\s*)+/i, '');
}

export function isInsufficientCredits(error) {
    return /insufficient[-_ ]credits/i.test(error?.code || '') || /insufficient[-_ ]credits/i.test(error?.message || '');
}

export function isRateLimitError(error) {
    const code = String(error?.code || '').toLowerCase().replace(/_/g, '-');
    return ['429', 'rate-limited', 'rate-limit', 'too-many-requests'].includes(code) ||
        error?.status === 429 || /too many requests|rate[-_ ]?limit/i.test(typeof error === 'string' ? error : error?.message || '');
}

export function isInternalServerError(error) {
    const code = String(error?.code || '').toLowerCase().replace(/_/g, '-');
    return ['internal-error', 'internal-server-error', '500'].includes(code) ||
        /^internal server error[.!]?$/i.test(errorMessage(error));
}

export function isServerShutdownError(error) {
    return /^shut[-_ ]?down$/i.test(String(error?.code || '').trim()) ||
        /^shut[-_ ]?down[.!]?$/i.test(errorMessage(error));
}

export function isTransientAutomationError(error) {
    return isInternalServerError(error) || isServerShutdownError(error) || isRateLimitError(error) ||
        ['game_reply_timeout', 'request_queue_full', 'socket_unavailable'].includes(error?.code) ||
        /^(?:Timed out waiting for COR3_WS_[A-Z_]+\.|.*(?:too many requests|rate[-_ ]?limit|token-expired|socket.*(?:closed|unavailable)|game connection (?:lost|is busy)))/i.test(errorMessage(error));
}

export function automationRetrySeconds(attempt) {
    return [30, 60, 120, 300][Math.min(Math.max(attempt - 1, 0), 3)];
}
