// Formatting is for the market jobs Logs tab only, never game payloads.
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const names = new Map();

export function rememberJobLogNames(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const name = value.name || value.callsign || value.serverName || value.fileName;
    if (typeof name === 'string') {
        const cleanName = name.replace(new RegExp(UUID_SOURCE, 'gi'), '').trim();
        if (cleanName) for (const key of ['id', 'moduleConfigId', 'jobId', 'itemId', 'fileId']) {
            const id = value[key];
            if (typeof id === 'string' && new RegExp('^' + UUID_SOURCE + '$', 'i').test(id)) {
                if (names.size >= 5000) names.delete(names.keys().next().value);
                names.set(id.toLowerCase(), cleanName);
            }
        }
    }
    for (const child of Object.values(value)) rememberJobLogNames(child, seen);
}

export function formatJobLog(message) {
    const text = String(message ?? '');
    // Older entries often append an ID to a name that is already present.
    const withoutSuffix = text.replace(new RegExp('\\s+\\((?:(?:new\\s+)?(?:id|fileId|moduleConfigId):\\s*)?' + UUID_SOURCE + '\\)', 'gi'), '');
    const fallback = /software/i.test(text) ? 'unknown software' : /server/i.test(text) ? 'unknown server'
        : /folder/i.test(text) ? 'Downloads folder' : /file/i.test(text) ? 'unknown file'
        : /job/i.test(text) ? 'unknown job' : 'unknown item';
    return withoutSuffix.replace(new RegExp(UUID_SOURCE, 'gi'), id => names.get(id.toLowerCase()) || fallback);
}

export function logItemName(id, items, fallback = 'Unknown item') {
    const item = (items || []).find(item => item.id === id || item.moduleConfigId === id);
    return formatJobLog(item?.name || fallback);
}
