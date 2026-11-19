import { droneSettings, dronePlan, pickDroneMission } from './drone-policy.js';
import { droneLiftoffSeconds, droneRepairSeconds, droneDurabilityLevel, formatDroneCountdown } from './drone-timing.js';

export function dronePanelStatus(snapshot, now = Date.now()) {
    const { options, updatedAt, mission, completed, automationStatus, queue, helperMode, availability } = snapshot;
    const batteryUpdatedAt = snapshot.batteryUpdatedAt ?? updatedAt;
    const repairUpdatedAt = snapshot.repairUpdatedAt ?? updatedAt;
    const settings = droneSettings(snapshot.settings);
    const drone = options?.drone;
    const automate = settings.enabled && !settings.paused && !helperMode;
    const suspension = helperMode ? 'Automation is suspended in Helper-Only Mode.'
        : !settings.enabled ? 'Automatic drone expeditions are off.'
        : settings.paused ? (automationStatus?.state === 'paused' ? automationStatus.message : 'Drone automation is paused.') : '';
    const queued = queue?.queued?.includes('auto-drone');
    const operationRunning = queue?.active === 'auto-drone' &&
        (!queue.startedAt || (Number.isFinite(automationStatus?.at) && automationStatus.at >= queue.startedAt));
    const view = (text, detail, className = 'resting', icon = null) => {
        const retry = automate && automationStatus?.phase === 'retry' && !text.startsWith('Retrying') && !['Rechecking drone', 'Waiting to recheck drone'].includes(text)
            ? 'Next check ' + (automationStatus.until > now ? 'in ' + formatDroneCountdown(Math.ceil((automationStatus.until - now) / 1000)) + '.' : 'pending.') : '';
        return { text, detail: [detail, retry, suspension].filter(Boolean).join(' '), className, icon };
    };
    const timed = (label, seconds, detail, expired, className, icon) =>
        view(seconds === 0 && expired ? expired : label + ' ' + formatDroneCountdown(seconds), detail, className, icon);

    if (!drone) {
        if (availability?.state === 'unavailable' || (options && Object.hasOwn(options, 'drone'))) {
            return view('Waiting for a drone', 'No drone is available yet. Unlock your drone in the game.' +
                (automate ? ' The helper checks every 5 minutes and will start automatically when it becomes available. You can also refresh now.' : ''), 'resting', '🔒');
        }
        return view('Waiting for drone data', 'Refresh the drone panel to load its current state.', 'resting', '🔎');
    }
    if (drone.isDestroyed) return view('Destroyed', 'Restore or replace the drone in game.', 'outcome-fail', '💥');

    if (options.activeMissionId) {
        const current = mission?.id === options.activeMissionId ? mission : null;
        if (completed?.missionId === options.activeMissionId || ['COMPLETED', 'FAILED', 'DESTROYED'].includes(current?.status)) {
            const collecting = automate && operationRunning && automationStatus?.phase === 'collecting';
            return view(collecting ? 'Collecting rewards' : automate && queued ? 'Rewards queued' : 'Rewards ready',
                collecting ? 'The expedition has ended. Collecting its rewards before the next trip.' : 'The expedition has ended. Its rewards are ready to collect.', 'resting', '📦');
        }
        const end = current?.endTime ? new Date(current.endTime).getTime() : NaN;
        const seconds = Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : null;
        return timed('On expedition', seconds, seconds === 0 ? 'Waiting for the drone to confirm its return.'
            : 'Time remaining until this expedition ends.', 'Awaiting return', 'contracted', seconds === 0 ? '⏳' : '🛩️');
    }

    const repairPlan = snapshot.repairPlan && (!snapshot.repairPlan.droneId || snapshot.repairPlan.droneId === drone.id)
        ? snapshot.repairPlan : null;
    const durability = droneDurabilityLevel(options, repairUpdatedAt, repairPlan, now);
    const fullyRepaired = Number.isFinite(drone.maxDurability) && drone.maxDurability > 0 && durability >= drone.maxDurability;
    if (drone.isRepairing && !fullyRepaired) {
        // Keep the repair's original target even if settings change mid-repair.
        const chargingRepair = repairPlan ? repairPlan.mode === 'charging' : snapshot.repairWhileCharging ??
            (automate && dronePlan({ ...options, drone: { ...drone, isRepairing: false } }, { ...settings, keepCreditReserve: false }).opportunistic === true);
        if (chargingRepair && automate) {
            const seconds = droneLiftoffSeconds(options, settings, batteryUpdatedAt, now);
            return timed('Repairing until liftoff', seconds,
                settings.fullCharge ? 'Repairing during the wait for a full battery before the next expedition.'
                    : 'Repairing during the wait for enough battery for the next expedition.', 'Awaiting liftoff', 'resting', seconds === 0 ? '⏳' : '🛠️');
        }
        const targetPercent = Number.isFinite(repairPlan?.targetPercent) ? repairPlan.targetPercent : chargingRepair ? null : settings.repairTarget;
        const reportedSeconds = Number.isFinite(drone.repairSecondsRemaining) && Number.isFinite(repairUpdatedAt)
            ? Math.max(0, Math.ceil(drone.repairSecondsRemaining - Math.max(0, (now - repairUpdatedAt) / 1000))) : null;
        const seconds = chargingRepair && !repairPlan ? reportedSeconds : droneRepairSeconds(options, settings, repairUpdatedAt, repairPlan, now);
        const chargingSeconds = automate ? droneLiftoffSeconds(options, settings, batteryUpdatedAt, now) : null;
        const batteryNote = chargingSeconds > 0 ? ' ' + (settings.fullCharge ? 'Full battery' : 'Launch charge') +
            ' in ' + formatDroneCountdown(chargingSeconds) + '.' : '';
        const repairView = timed(targetPercent == null ? 'Repairing while charging' : 'Repairing to ' + targetPercent + '%', seconds,
            (targetPercent == null ? 'Time remaining until the current repair finishes.'
                : 'Time remaining for the repair to reach its ' + targetPercent + '% target.') + batteryNote +
            (chargingRepair ? ' Charging repairs can exceed the normal repair target.' : ''), 'Finishing repair', 'resting', '🛠️');
        if (automate) repairView.secondaryText = (settings.fullCharge ? 'Full charge ' : 'Launch charge ') + formatDroneCountdown(chargingSeconds);
        return repairView;
    }

    if (helperMode) return view('Helper-Only Mode', '', 'resting', '⏸️');
    if (!settings.enabled) return view('Auto-send off', '', 'available', '⏹️');
    if (settings.paused) return view('Paused', '', 'outcome-fail', '⏸️');

    if (automationStatus?.phase === 'repair-confirmation') return view('Awaiting repair confirmation',
        'The last repair was accepted. Waiting for the game to report its final durability.', 'resting', '🛠️');

    if (automationStatus?.phase === 'retry') {
        const seconds = Number.isFinite(automationStatus.until) ? Math.max(0, Math.ceil((automationStatus.until - now) / 1000)) : null;
        return timed('Retrying in', seconds, automationStatus.message, operationRunning ? 'Rechecking drone' : 'Waiting to recheck drone', 'resting', '🔄');
    }
    if (automationStatus?.phase === 'credits') {
        const seconds = Number.isFinite(automationStatus.until) ? Math.max(0, Math.ceil((automationStatus.until - now) / 1000)) : 0;
        return seconds > 0 ? timed('Waiting for credits · retry', seconds, automationStatus.message, null, 'resting', '💰')
            : view('Waiting for credits', automationStatus.message, 'resting', '💰');
    }
    if (operationRunning && automationStatus?.phase === 'collecting') return view('Collecting rewards', automationStatus.message, 'resting', '📦');
    if (operationRunning && automationStatus?.phase === 'launching') return view('Launching', automationStatus.message, 'contracted', '🛫');

    // Actual credit waits are reported by automationStatus above. This preview
    // has no authoritative balance and must not invent a funding failure.
    const plan = dronePlan(fullyRepaired && drone.isRepairing ? { ...options, drone: { ...drone, durability, isRepairing: false } } : options,
        { ...settings, keepCreditReserve: false });
    if (plan.type === 'pause') {
        const missionAvailable = pickDroneMission(options, settings);
        return view(!missionAvailable ? 'Select a mission' : /Repair in game/.test(plan.message) ? 'Needs repair' : 'Needs attention', plan.message, 'outcome-fail',
            !missionAvailable ? '📍' : /Repair in game/.test(plan.message) ? '🛠️' : '⚠️');
    }
    if (plan.phase === 'retry') return view('Waiting for drone data', plan.message, 'resting', '🔎');
    if (plan.type === 'repair' && !plan.opportunistic) {
        return view(queued ? 'Repair queued' : 'Repair pending', 'Waiting to start a repair to ' + settings.repairTarget + '% durability.', 'resting', queued ? '⏳' : '🛠️');
    }
    const seconds = droneLiftoffSeconds(options, settings, batteryUpdatedAt, now);
    if (seconds == null || seconds > 0) {
        return timed(settings.fullCharge ? 'Charging to full' : 'Charging for liftoff', seconds,
            settings.fullCharge ? 'Waiting for a full battery before launching.' : 'Waiting for enough battery for the selected expedition.', null, 'resting', '⚡');
    }
    if (drone.isRepairing) return view('Finishing repair', 'Waiting for the game to confirm that the repair is complete.', 'resting', '🛠️');
    return view(queued ? 'Waiting for automation' : 'Ready for liftoff', queued
        ? 'The drone is ready. Waiting for other automation to finish before launching.'
        : 'The battery is ready for the next expedition. Waiting for launch confirmation.', 'available', queued ? '⏳' : '✅');
}
