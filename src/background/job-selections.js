const marketKeys = { marketData: 'home', darkMarketData: 'dark', soyuzMarketData: 'soyuz', usolMarketData: 'usol' };
let pending = Promise.resolve();

export function clearSelectionsForNewJobs(changes) {
    const markets = Object.entries(marketKeys).filter(([key]) => {
        const change = changes[key];
        if (!Array.isArray(change?.newValue?.jobs)) return false;
        const knownIds = new Set([...(change.oldValue?.jobs || []), ...(change.oldValue?.recentJobs || [])].map(job => job.id));
        return change.newValue.jobs.some(job => job.id && !knownIds.has(job.id));
    }).map(([, market]) => market);
    if (!markets.length) return pending;
    // Separate market replies can arrive together. Serialize their updates so
    // clearing one market cannot restore another market's previous selections.
    const write = pending.then(async () => {
        const { autoJobsSelectedTypes = {} } = await chrome.storage.sync.get('autoJobsSelectedTypes');
        const next = { ...autoJobsSelectedTypes };
        let changed = false;
        for (const market of markets) {
            if (!next[market]?.length) continue;
            next[market] = [];
            changed = true;
        }
        if (changed) await chrome.storage.sync.set({ autoJobsSelectedTypes: next });
    });
    pending = write.catch(() => {});
    return write;
}
