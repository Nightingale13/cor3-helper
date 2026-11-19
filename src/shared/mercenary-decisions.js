export function decisionKey(decision) {
    return JSON.stringify([decision.expeditionId, decision.messageId]);
}

// Normalize the game's expedition messages for the shared Decisions rules.
export function mercenaryDecisions(expeditions) {
    return (expeditions || []).flatMap(expedition => (expedition.messages || [])
        .filter(message => message.id && Array.isArray(message.decisionOptions))
        .map(message => ({
            expeditionId: expedition.id,
            mercenaryCallsign: expedition.mercenary?.callsign || 'Unknown',
            locationName: expedition.locationName || '', zoneName: expedition.zoneName || '',
            riskScore: expedition.riskScore || 0,
            ...message, messageId: message.id,
            isResolved: !!(message.isResolved || message.isAutoResolved || message.selectedOption)
        })));
}
