export function droneEventKey(missionId, eventId) { return missionId + ':' + eventId; }

export function isSupersededDroneEvent(error) {
    return /\bevent\b.*\bexpired\b.*\bnewer event\b/i.test(error?.message || '');
}

export function currentDroneDecision(options, mission, eventCache, retired = [], missionUpdatedAt = 0) {
    const missionId = options?.activeMissionId;
    if (!missionId) return null;
    if (mission?.id !== missionId) mission = null;
    const snapshot = Array.isArray(mission?.channelEvents) ? mission.channelEvents.at(-1) : null;
    const push = Object.values(eventCache || {}).filter(entry => entry.missionId === missionId && entry.event?.eventId).at(-1);
    let event = snapshot;
    if (push && (!snapshot || !push.receivedAt || push.receivedAt >= missionUpdatedAt)) event = push.event;
    if (!event?.eventId || !event.isResolvable || event.isResolved || event.isExpired) return null;
    if (retired.some(entry => entry.missionId === missionId && entry.eventId === event.eventId)) return null;
    if (mission?.resolvedEvents?.some(entry => entry.eventId === event.eventId)) return null;
    const deadline = event.decisionDeadline || event.expiresAt || event.deadline || null;
    if (deadline && new Date(deadline).getTime() <= Date.now()) return null;
    const location = mission?.location?.name || mission?.locationName || '';
    const missionName = mission?.mission?.name || mission?.missionName || '';
    return {
        _kind: 'drone', expeditionId: missionId, messageId: event.eventId,
        mercenaryCallsign: options.drone?.name || mission?.droneName || 'Drone',
        locationName: location, zoneName: missionName, content: event.message || event.content || event.type || 'Drone decision',
        decisionDeadline: deadline, isResolved: false, riskScore: mission?.finalRisk ?? mission?.riskScore ?? 0,
        decisionOptions: (event.options || []).map(option => ({ ...option,
            riskModifier: option.riskModifier ?? option.effect?.riskDelta ?? 0,
            lootModifier: option.lootModifier ?? option.effect?.lootDelta ?? 0,
            unavailable: !!option.requiredModuleId
        }))
    };
}
