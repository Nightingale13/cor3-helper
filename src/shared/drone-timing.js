import { pickDroneMission } from './drone-policy.js';
import { droneChargeSeconds } from './drone-battery.js';

export function droneLiftoffSeconds(options, settings, updatedAt, now = Date.now()) {
    const drone = options?.drone;
    const battery = options?.battery;
    const mission = pickDroneMission(options, settings);
    if (!settings.enabled || settings.paused || !drone || drone.isDestroyed || options.activeMissionId || !mission ||
        !Number.isFinite(battery?.current) || battery.current < 0 ||
        !Number.isFinite(battery?.max) || battery.max <= 0 || mission.batteryCost > battery.max ||
        !Number.isFinite(updatedAt)) return null;
    const needed = settings.fullCharge ? battery.max : mission.batteryCost;
    const chargingSeconds = droneChargeSeconds(battery, needed);
    if (chargingSeconds == null) return null;
    // Charging repairs use the wait for launch charge, not the full-repair estimate.
    const elapsed = Math.max(0, (now - updatedAt) / 1000);
    return Math.max(0, Math.ceil(chargingSeconds - elapsed));
}

export function formatDroneCountdown(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remainingSeconds = String(seconds % 60).padStart(2, '0');
    return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + remainingSeconds
        : minutes + ':' + remainingSeconds;
}

export function droneRepairSeconds(options, settings, updatedAt, repairPlan, now = Date.now()) {
    if (Number.isFinite(repairPlan?.endsAt)) return Math.max(0, Math.ceil((repairPlan.endsAt - now) / 1000));
    const drone = options?.drone;
    const rate = options?.repairRate?.secondsPerPoint;
    if (!Number.isFinite(updatedAt) || !Number.isFinite(drone?.maxDurability) || drone.maxDurability <= 0 ||
        !Number.isFinite(drone.durability) || !Number.isFinite(rate) || rate < 0) return null;
    const target = Math.ceil(drone.maxDurability * settings.repairTarget / 100);
    const seconds = Math.max(0, target - drone.durability) * rate;
    return Math.max(0, Math.ceil(seconds - Math.max(0, (now - updatedAt) / 1000)));
}

export function droneDurabilityLevel(options, updatedAt, repairPlan, now = Date.now()) {
    const drone = options?.drone;
    const current = drone?.durability;
    if (!Number.isFinite(current)) return null;
    if (!drone.isRepairing || drone.isDestroyed || !Number.isFinite(drone.maxDurability) || drone.maxDurability <= 0) return current;
    const repair = drone.repair;
    let start, target, total, remaining;
    if (Number.isFinite(repair?.startDurability) && Number.isFinite(repair.targetDurability) &&
        Number.isFinite(repair.totalSeconds) && Number.isFinite(repair.secondsRemaining) && Number.isFinite(updatedAt)) {
        start = repair.startDurability;
        target = repair.targetDurability;
        total = repair.totalSeconds;
        remaining = repair.secondsRemaining - Math.max(0, (now - updatedAt) / 1000);
    } else if (repairPlan && (!repairPlan.droneId || repairPlan.droneId === drone.id) &&
        Number.isFinite(repairPlan.startedAt) && Number.isFinite(repairPlan.endsAt) && Number.isFinite(repairPlan.targetDurability)) {
        target = repairPlan.targetDurability;
        total = (repairPlan.endsAt - repairPlan.startedAt) / 1000;
        const rate = options.repairRate?.secondsPerPoint;
        start = Number.isFinite(repairPlan.startDurability) ? repairPlan.startDurability
            : Number.isFinite(rate) && rate > 0 ? target - total / rate : null;
        remaining = (repairPlan.endsAt - now) / 1000;
    } else return current;
    if (!Number.isFinite(start) || total < 0 || target < start) return current;
    const progress = total > 0 ? Math.max(0, Math.min(1, (total - remaining) / total)) : 1;
    return Math.min(drone.maxDurability, Math.max(current, start + Math.round((target - start) * progress)));
}
