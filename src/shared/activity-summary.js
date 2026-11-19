export function activityDay(at = Date.now()) {
    const date = new Date(at);
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

export function emptyActivityDay() {
    return { jobs: 0, jobEarnings: 0, reputation: 0, marketXp: 0, skipped: 0, creditsIn: 0, creditsOut: 0,
        mercenaries: 0, mercenaryCost: 0, mercenaryUnknown: 0,
        flights: 0, repairCost: 0, repairUnknown: 0, recent: [] };
}

export function availableActivityDays(summary, now = Date.now()) {
    const today = activityDay(now);
    return Object.keys(summary?.days || {}).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day) && day !== today)
        .sort((a, b) => b.localeCompare(a));
}

// A completed job resolves its earlier skips, including skips recorded on a
// previous day. Remove their ledger entries so reconciliation is idempotent.
export function reconcileActivityJobs(saved, completedJobId = null) {
    if (!saved?.seen) return saved;
    let days = saved.days;
    let seen = saved.seen;
    for (const id of Object.keys(saved.seen)) {
        const match = /^skip:(\d{4}-\d{2}-\d{2}):(.+)$/.exec(id);
        if (!match || (match[2] !== completedJobId && !Object.hasOwn(saved.seen, 'job:' + match[2]))) continue;
        if (seen === saved.seen) { seen = { ...saved.seen }; days = { ...saved.days }; }
        delete seen[id];
        const day = days[match[1]];
        if (day) days[match[1]] = { ...day, skipped: Math.max(0, (day.skipped || 0) - 1) };
    }
    return seen === saved.seen ? saved : { ...saved, days, seen };
}

export function applyActivity(saved, event, now = Date.now()) {
    if (!event?.id || !['credits', 'jobDone', 'jobSkipped', 'mercenaryLaunch', 'droneLaunch', 'droneRepair'].includes(event.kind)) return saved;
    const jobId = event.jobId || (event.kind === 'jobDone' ? /^job:(.+)$/.exec(event.id || '')?.[1]
        : event.kind === 'jobSkipped' ? /^skip:\d{4}-\d{2}-\d{2}:(.+)$/.exec(event.id || '')?.[1] : null);
    if (event.kind === 'jobDone' && jobId) saved = reconcileActivityJobs(saved, jobId);
    // A delayed failure snapshot must never undo a confirmed completion.
    if (event.kind === 'jobSkipped' && jobId && Object.hasOwn(saved?.seen || {}, 'job:' + jobId)) return saved;
    if (Object.hasOwn(saved?.seen || {}, event.id)) return saved;
    if (event.kind === 'credits' && (!Number.isFinite(event.amount) || event.amount === 0)) return saved;
    if (event.kind === 'credits' && Number.isFinite(event.balance) && saved?.lastCredit?.balance === event.balance &&
        saved.lastCredit.amount === event.amount && now - saved.lastCredit.at < 2000) return saved;
    const key = activityDay(now);
    const current = { ...saved, since: saved?.since ?? now, days: saved?.days || {}, seen: saved?.seen || {} };
    const day = { ...emptyActivityDay(), ...current.days[key] };
    const cost = Number.isFinite(event.cost) && event.cost >= 0 ? event.cost : null;
    if (event.kind === 'credits') {
        if (event.amount > 0) day.creditsIn += event.amount;
        else day.creditsOut += Math.abs(event.amount);
    } else if (event.kind === 'jobDone') {
        day.jobs++;
        if (Number.isFinite(event.earnings)) day.jobEarnings += event.earnings;
        if (Number.isFinite(event.reputation)) day.reputation += event.reputation;
        if (Number.isFinite(event.marketXp)) day.marketXp += event.marketXp;
    } else if (event.kind === 'jobSkipped') day.skipped++;
    else if (event.kind === 'mercenaryLaunch') {
        day.mercenaries++;
        if (cost == null) day.mercenaryUnknown++; else day.mercenaryCost += cost;
    } else if (event.kind === 'droneLaunch') day.flights++;
    else if (event.kind === 'droneRepair') {
        if (cost == null) day.repairUnknown++; else day.repairCost += cost;
    }
    if (event.kind !== 'credits') day.recent = [{ kind: event.kind, at: now, name: event.name || '', reason: event.reason || '' }, ...day.recent].slice(0, 8);
    const days = { ...current.days, [key]: day };
    const keptDays = Object.fromEntries(Object.entries(days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14));
    const seen = { ...current.seen, [event.id]: now };
    const keptSeen = Object.fromEntries(Object.entries(seen).filter(([, at]) => now - at < 30 * 86400000)
        .sort(([, a], [, b]) => b - a).slice(0, 20000));
    return { ...current, days: keptDays, seen: keptSeen,
        ...(event.kind === 'credits' ? { lastCredit: { amount: event.amount, balance: event.balance, at: now } } : {}) };
}
