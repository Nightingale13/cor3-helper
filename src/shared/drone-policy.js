import { droneChargeSeconds } from './drone-battery.js';
import { DRONE_AVAILABILITY_CHECK_MS } from './drone-availability.js';

export const DRONE_DEFAULTS = {
    enabled: false, paused: false, autoChooseMission: true, locationConfigId: '', missionConfigId: '',
    autoRepair: true, repairThreshold: 20, repairTarget: 60, repairWhileCharging: true, fullCharge: false, keepCreditReserve: true
};

export function droneSettings(settings) {
    return { ...DRONE_DEFAULTS, ...settings };
}

export function isDroneAlreadyFullyRepaired(error) {
    return /^Drone durability is already full[.!]?$/i.test(repairErrorMessage(error));
}

function repairErrorMessage(error) {
    return (error?.message || '').trim().replace(/^(?:(?:Drone automation paused|Something went wrong):\s*)+/i, '');
}

export function isDroneRepairStateConflict(error) {
    return isDroneAlreadyFullyRepaired(error) ||
        /^Repair target must be above current durability[.!]?$/i.test(repairErrorMessage(error));
}

export function matchesRejectedDroneRepair(options, rejected) {
    return !!rejected && !!options?.drone && !options.activeMissionId && !options.drone.isRepairing &&
        // Idle durability cannot fall without another mission. A different
        // stale reading must not allow the same rejected repair to run again.
        options.drone.id === rejected.droneId &&
        options.drone.durability < options.drone.maxDurability &&
        options.drone.maxDurability === rejected.maxDurability;
}

export function awaitingConfirmedDroneRepair(options, repair) {
    const drone = options?.drone;
    return !!repair?.confirmed && !!drone && drone.id === repair.droneId &&
        !options.activeMissionId && !drone.isDestroyed && !drone.isRepairing &&
        (!Number.isFinite(repair.maxDurability) || repair.maxDurability === drone.maxDurability) &&
        Number.isFinite(drone.durability) && drone.durability < repair.targetDurability;
}

export function droneOptionsAfterUpdate(options, update) {
    const drone = options?.drone;
    if (!drone || update?.missionId || !Number.isFinite(update?.durability) || update.durability < 0 ||
        !Number.isFinite(drone.maxDurability) || update.durability > drone.maxDurability ||
        (update.droneId && update.droneId !== drone.id)) return null;
    return { ...options, drone: { ...drone, durability: update.durability, isRepairing: false,
        repairSecondsRemaining: null, repair: null } };
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
    if (!drone) return { type: 'wait', phase: 'unlock', seconds: DRONE_AVAILABILITY_CHECK_MS / 1000,
        message: 'Waiting for a drone. Unlock it in the game to use drone automation.' };
    if (drone.isDestroyed) return { type: 'pause', message: 'Drone destroyed. Restore or replace it in game before resuming.' };
    if (drone.isRepairing) return { type: 'wait', message: 'Repair in progress.', seconds: drone.repair?.secondsRemaining ?? drone.repairSecondsRemaining };
    if (options.activeMissionId) return { type: 'active', missionId: options.activeMissionId };
    const spendableCredits = settings.keepCreditReserve === true
        ? Number.isFinite(availableCredits) ? Math.max(0, availableCredits - 2000) : 0 : availableCredits;
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
        if (settings.keepCreditReserve === true && normalRepair.cost > spendableCredits) {
            return { type: 'wait', phase: 'credits', seconds: 60,
                message: 'Waiting for enough credits to repair the drone and keep 2,000 for jobs.' };
        }
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
            const repair = chargingRepairPlan(options, seconds, spendableCredits);
            if (repair && (!normalRepair || repair.targetDurability >= normalRepair.targetDurability)) return { ...repair, mission };
        }
        if (normalRepair || repairRequired) return normalRepair || repairRequired;
        return { type: 'wait', message: settings.fullCharge ? 'Waiting for a full battery.' : 'Waiting for enough battery.', seconds: seconds == null ? null : Math.ceil(seconds), mission };
    }
    if (normalRepair || repairRequired) return normalRepair || repairRequired;
    return { type: 'launch', mission };
}

