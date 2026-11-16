export function historyItems(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.data)) return data.data;
    return [];
}

function missionTime(mission) {
    const time = new Date(mission.completedAt || mission.endTime || mission.startTime || 0).getTime();
    return Number.isFinite(time) ? time : 0;
}

// Remote history wins over locally observed completions. Keep IDs scoped by source.
export function mergeDroneHistory(remote, observed = []) {
    const byId = new Map();
    for (const mission of [...historyItems(observed), ...historyItems(remote)]) {
        if (mission?.id) byId.set(mission.id, { ...byId.get(mission.id), ...mission });
    }
    return [...byId.values()].sort((a, b) => missionTime(b) - missionTime(a)).slice(0, 100);
}

export function combinedExpeditionHistory(mercenaries, drones) {
    return [
        ...historyItems(mercenaries).map(mission => ({ ...mission, _kind: 'mercenary' })),
        ...historyItems(drones).map(mission => ({ ...mission, _kind: 'drone' }))
    ].sort((a, b) => missionTime(b) - missionTime(a));
}

export function activeDroneMission(options, cachedMission) {
    if (!options?.activeMissionId) return null;
    // Old cached data must never supply the location/timer of a different flight.
    const mission = cachedMission?.id === options.activeMissionId ? cachedMission : {};
    const location = options.locations?.find(item => item.id === mission.locationConfigId);
    const configuration = location?.missions?.find(item => item.id === mission.missionConfigId);
    return {
        id: options.activeMissionId, status: mission.status || 'IN_PROGRESS',
        droneName: mission.drone?.name || mission.droneName || options.drone?.name || 'Drone',
        locationName: mission.location?.name || mission.locationName || location?.name || null,
        missionName: mission.mission?.name || mission.missionName || configuration?.name || null,
        batteryCost: mission.batteryCost ?? mission.mission?.batteryCost ?? configuration?.batteryCost,
        risk: mission.finalRisk ?? mission.riskScore,
        startTime: mission.startTime || null, endTime: mission.endTime || null
    };
}
