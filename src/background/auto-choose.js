import { getCor3Tab } from './helpers.js';
import { decisionScore } from '../shared/decision-policy.js';

const autoChosenDecisions = new Set();

export async function checkAutoChooseBackground() {
    try {
        const settings = await chrome.storage.sync.get(['decisionModifiers', 'helperMode']);
        const mods = settings.decisionModifiers || {};
        if (settings.helperMode || mods.autoChoose === false) return;

        const { expeditionDecisions, expeditionsData } = await chrome.storage.local.get(['expeditionDecisions', 'expeditionsData']);
        const decisions = expeditionDecisions || [];
        if (decisions.length === 0) return;

        for (const d of decisions) {
            if (d.isResolved || !d.decisionDeadline || !Array.isArray(d.decisionOptions)) continue;
            if (autoChosenDecisions.has(d.messageId)) continue;
            const dl = new Date(d.decisionDeadline);
            const remaining = dl - Date.now();
            if (remaining <= 0) continue;
            if (mods.noWaitAutoChoose === false && remaining > 60000) continue;

            let bestOpt = null;
            let bestScore = -Infinity;
            const veteranOverride = mods.getRidOfVeterans !== false && (expeditionsData || []).some(exp =>
                exp.id === d.expeditionId && String(exp.mercenary?.rank || '').toUpperCase() === 'VETERAN');
            for (const opt of d.decisionOptions) {
                const score = decisionScore(opt, d.riskScore, mods, veteranOverride);
                if (score > bestScore) {
                    bestScore = score;
                    bestOpt = opt;
                }
            }
            if (bestOpt) {
                autoChosenDecisions.add(d.messageId);
                try {
                    const tab = await getCor3Tab();
                    if (tab) {
                        await chrome.tabs.sendMessage(tab.id, {
                            action: 'respondDecision',
                            expeditionId: d.expeditionId,
                            messageId: d.messageId,
                            selectedOption: bestOpt.id
                        });
                        console.log(`[COR3 Helper BG] Auto-chose "${bestOpt.label}" (score: ${bestScore})`);
                    }
                } catch (e) { /* silent */ }
            }
        }
    } catch (e) {
        console.log('[COR3 Helper] Background auto-choose failed:', e);
        cor3LogError('background.js', e, { action: 'checkAutoChooseBackground' });
    }
}
