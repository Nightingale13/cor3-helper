// One score formula and modifier defaults for both expedition types and the popup.
export function decisionScore(option, riskScore, modifiers = {}, veteranOverride = false) {
    const lootWeight = veteranOverride ? 1 : modifiers.enabled === false ? 1 : (modifiers.loot ?? 1);
    const riskWeight = veteranOverride ? 10 : modifiers.enabled === false ? -1 : (modifiers.risk ?? -5);
    const risk = Number.isFinite(option.riskModifier) ? option.riskModifier : 0;
    const loot = Number.isFinite(option.lootModifier) ? option.lootModifier : 0;
    const baseRisk = Number.isFinite(riskScore) ? riskScore : 0;
    return Math.round(loot * lootWeight + risk * riskWeight * (((baseRisk + Math.abs(risk)) / 10) || 1));
}

export function decisionReady(decision, modifiers = {}, now = Date.now()) {
    if (modifiers.autoChoose === false || decision.isResolved) return false;
    if (!decision.decisionDeadline) return true; // current events without a reported deadline cannot be scheduled
    const remaining = new Date(decision.decisionDeadline).getTime() - now;
    return Number.isFinite(remaining) && remaining > 0 && (modifiers.noWaitAutoChoose !== false || remaining <= 60000);
}

export function bestDecisionOption(decision, modifiers, veteranOverride = false) {
    let best = null, score = -Infinity;
    for (const option of decision.decisionOptions || []) {
        if (!option.id || option.unavailable) continue;
        const candidate = decisionScore(option, decision.riskScore, modifiers, veteranOverride);
        if (candidate > score) { best = option; score = candidate; }
    }
    return best;
}
