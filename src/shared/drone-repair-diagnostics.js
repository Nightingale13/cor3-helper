import { BUILD_ID } from './build-info.js';

export function repairDiagnosticText(value) {
    return String(value || '').replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '[identifier]').slice(0, 500);
}

export function repairDiagnosticSnapshot(options) {
    const drone = options?.drone;
    const number = value => Number.isFinite(value) ? value : null;
    return { name: repairDiagnosticText(drone?.name || 'Drone'), durability: number(drone?.durability),
        maxDurability: number(drone?.maxDurability), repairing: !!drone?.isRepairing, destroyed: !!drone?.isDestroyed,
        activeMission: !!options?.activeMissionId, repairSecondsRemaining: number(drone?.repair?.secondsRemaining ?? drone?.repairSecondsRemaining),
        repairTarget: number(drone?.repair?.targetDurability), creditsPerPoint: number(options?.repairRate?.creditsPerPoint),
        secondsPerPoint: number(options?.repairRate?.secondsPerPoint) };
}

export function mergeRepairDiagnostics(saved = {}, update) {
    const entry = update?.entry;
    if (!entry || !Number.isFinite(entry.at) || typeof entry.stage !== 'string') return saved;
    const recent = [...(saved.recent || []), entry].slice(-80);
    const incidents = [...(saved.incidents || [])];
    if (entry.stage === 'reply' && entry.error) incidents.push({ at: entry.at,
        mainBuild: entry.build, contentBuild: BUILD_ID, history: (update.history || recent).slice(-40),
        repair: update.repair ? { confirmed: !!update.repair.confirmed, mode: update.repair.mode,
            startDurability: update.repair.startDurability, targetDurability: update.repair.targetDurability,
            startedAt: update.repair.startedAt, endsAt: update.repair.endsAt } : null });
    return { contentBuild: BUILD_ID, mainBuild: entry.build, recent, incidents: incidents.slice(-10) };
}
