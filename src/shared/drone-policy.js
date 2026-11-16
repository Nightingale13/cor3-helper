import { droneChargeSeconds } from './drone-battery.js';

export const DRONE_DEFAULTS = {
    enabled: true, paused: false, autoChooseMission: true, locationConfigId: '', missionConfigId: '',
    autoRepair: true, repairThreshold: 20, repairTarget: 60, repairWhileCharging: true, fullCharge: false
};

export function droneSettings(settings) {
    return { ...DRONE_DEFAULTS, ...settings };
}

export function isDroneAlreadyFullyRepaired(error) {
    return /^(?:Drone automation paused:\s*)?Drone durability is already full[.!]?$/i.test(error?.message?.trim() || '');
}

export function isDroneRepairStateConflict(error) {
    return isDroneAlreadyFullyRepaired(error) ||
        /^(?:Drone automation paused:\s*)?Repair target must be above current durability[.!]?$/i.test(error?.message?.trim() || '');
}

export function pickDroneMission(options, settings) {
    const locations = Array.isArray(options?.locations) ? options.locations : [];
    const candidates = locations.flatMap(location => (location.missions || []).map(mission => ({
        ...mission, locationConfigId: location.id, locationName: location.name, baseRisk: location.baseRisk
    }))).filter(m => m.id && m.locationConfigId && Number.isFinite(m.batteryCost) && m.batteryCost >= 0 &&
        Number.isFinite(m.durationSeconds) && m.durationSeconds > 0);
    if (settings.autoChooseMission) {
        return candidates.sort((a, b) => a.batteryCost - b.batteryCost ||
            (a.baseRisk ?? Infinity) - (b.baseRisk ?? Infinity) || a.durationSeconds - b.durationSeconds)[0] || null;
    }
    return candidates.find(m => (!settings.locationConfigId || m.locationConfigId === settings.locationConfigId) &&
        (!settings.missionConfigId || m.id === settings.missionConfigId)) || null;
}

// Leave time for request/response latency and rounding in the reported recharge rate.
const CHARGING_REPAIR_BUFFER_SECONDS = 30;

export function chargingRepairPlan(options, chargingSeconds, availableCredits) {
    const drone = options?.drone;
    const rate = options?.repairRate;
    if (!drone || drone.isDestroyed || drone.isRepairing || options.activeMissionId ||
        !Number.isFinite(chargingSeconds) || chargingSeconds <= CHARGING_REPAIR_BUFFER_SECONDS ||
        !Number.isInteger(drone.durability) || !Number.isInteger(drone.maxDurability) ||
        drone.durability < 0 || drone.maxDurability <= drone.durability ||
        !Number.isFinite(rate?.secondsPerPoint) || rate.secondsPerPoint <= 0 ||
        !Number.isFinite(rate?.creditsPerPoint) || rate.creditsPerPoint < 0) return null;
    const timePoints = Math.floor((chargingSeconds - CHARGING_REPAIR_BUFFER_SECONDS) / rate.secondsPerPoint);
    // When no balance has been observed in this session, the server validates affordability.
    const creditPoints = Number.isFinite(availableCredits) && rate.creditsPerPoint > 0
        ? Math.floor(Math.max(0, availableCredits) / rate.creditsPerPoint) : Infinity;
    const points = Math.min(drone.maxDurability - drone.durability, timePoints, creditPoints);
    if (points < 1) return null;
    return { type: 'repair', opportunistic: true, targetDurability: drone.durability + points,
        cost: points * rate.creditsPerPoint, seconds: points * rate.secondsPerPoint, chargingSeconds };
}

export function dronePlan(options, settings, availableCredits) {
    const drone = options?.drone;
    if (!drone) return { type: 'pause', message: 'Personal drone is not available.' };
    if (drone.isDestroyed) return { type: 'pause', message: 'Drone destroyed. Restore or replace it in game before resuming.' };
    if (drone.isRepairing) return { type: 'wait', message: 'Repair in progress.', seconds: drone.repair?.secondsRemaining ?? drone.repairSecondsRemaining };
    if (options.activeMissionId) return { type: 'active', missionId: options.activeMissionId };
    if (!Number.isFinite(drone.durability) || !Number.isFinite(drone.maxDurability) || drone.maxDurability <= 0 ||
        drone.durability < 0 || drone.durability > drone.maxDurability) {
        return { type: 'wait', phase: 'retry', seconds: 60, message: 'Waiting for current drone durability. Retrying automatically.' };
    }
    const threshold = Number(settings.repairThreshold), target = Number(settings.repairTarget);
    if (!Number.isFinite(threshold) || !Number.isFinite(target) || threshold < 0 || threshold >= target || target > 100) {
        return { type: 'pause', message: 'Repair target must exceed the repair threshold (0–100%).' };
    }
    const needsNormalRepair = drone.durability <= drone.maxDurability * threshold / 100 || drone.durability <= 0;
    let normalRepair = null;
    if (needsNormalRepair && settings.autoRepair) {
        const targetDurability = Math.ceil(drone.maxDurability * target / 100);
        const points = targetDurability - drone.durability;
        if (!Number.isFinite(options.repairRate?.creditsPerPoint) || options.repairRate.creditsPerPoint < 0 ||
            !Number.isFinite(options.repairRate?.secondsPerPoint) || options.repairRate.secondsPerPoint < 0) {
            return { type: 'wait', phase: 'retry', seconds: 60, message: 'Waiting for current repair price and duration. Retrying automatically.' };
        }
        normalRepair = { type: 'repair', targetDurability, cost: points * options.repairRate.creditsPerPoint,
            seconds: points * options.repairRate.secondsPerPoint };
    }
    const repairRequired = needsNormalRepair && !normalRepair
        ? { type: 'pause', message: 'Durability reached the repair threshold. Repair in game or enable automatic repair.' } : null;
    const mission = pickDroneMission(options, settings);
    if (!mission) return normalRepair || repairRequired || { type: 'pause', message: 'Select an available drone location and mission with a known battery cost.' };
    const battery = options.battery;
    if (!Number.isFinite(battery?.current) || !Number.isFinite(battery?.max) || battery.max <= 0 || battery.current < 0) {
        return normalRepair || repairRequired || { type: 'wait', phase: 'retry', seconds: 60, message: 'Waiting for current drone battery data. Retrying automatically.' };
    }
    if (mission.batteryCost > battery.max) return normalRepair || repairRequired || { type: 'pause', message: 'This mission requires more battery than the drone can hold.' };
    const needed = settings.fullCharge ? battery.max : mission.batteryCost;
    if (battery.current < needed) {
        const seconds = droneChargeSeconds(battery, needed);
        if (settings.repairWhileCharging) {
            const repair = chargingRepairPlan(options, seconds, availableCredits);
            if (repair && (!normalRepair || repair.targetDurability >= normalRepair.targetDurability)) return { ...repair, mission };
        }
        if (normalRepair || repairRequired) return normalRepair || repairRequired;
        return { type: 'wait', message: settings.fullCharge ? 'Waiting for a full battery.' : 'Waiting for enough battery.', seconds: seconds == null ? null : Math.ceil(seconds), mission };
    }
    if (normalRepair || repairRequired) return normalRepair || repairRequired;
    return { type: 'launch', mission };
}

