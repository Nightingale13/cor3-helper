// Mercenary choices have their own owner, independent of drone automation.
import { decisionReady, bestDecisionOption } from '../shared/decision-policy.js';
import { mercenaryDecisions, decisionKey } from '../shared/mercenary-decisions.js';
import { waitForGameReply } from './expedition-mail.js';
import { isRateLimitError } from '../shared/automation-recovery.js';

const attempts = new Map();
let decisionWrite = Promise.resolve();
let refreshing = null;
let refreshAgain = false;
let installed = false;
let lastRefreshAt = Date.now();
let updateWrite = Promise.resolve();

export function receiveMercenaryUpdate(data) {
    const write = updateWrite.then(async () => {
        await decisionWrite;
        const { expeditionsData = [] } = await chrome.storage.local.get('expeditionsData');
        const updates = Array.isArray(data) ? data : [data?.expedition || data];
        const current = [...expeditionsData];
        const changed = [];
        for (const raw of updates) {
            if (!raw) continue;
            const message = raw.message || (Array.isArray(raw.decisionOptions) ? raw : null);
            if (!Array.isArray(raw.messages) && !message) continue;
            const id = raw.expeditionId || (Array.isArray(raw.messages) ? raw.id : null) || message?.expeditionId;
            const previous = current.find(exp => exp.id === id);
            const patch = Array.isArray(raw.messages) ? raw : {};
            const expedition = { ...previous, ...patch, id,
                mercenary: { ...previous?.mercenary, ...patch.mercenary } };
            if (!id || !Number.isFinite(expedition.riskScore) || !expedition.mercenary?.rank || !expedition.status) continue;
            if (!['IN_PROGRESS', 'RUNNING'].includes(expedition.status)) continue;
            const messages = new Map((patch.messages || previous?.messages || []).map(item => [item.id, item]));
            if (message?.decisionOptions && !message.isResolved && !message.selectedOption) {
                const currentId = message.id || message.messageId;
                for (const [key, previousMessage] of messages) {
                    if (key !== currentId && previousMessage.decisionOptions && !previousMessage.isResolved) {
                        messages.set(key, { ...previousMessage, isResolved: true, isAutoResolved: true });
                    }
                }
            }
            for (const item of [...(patch.messages || []), ...(message ? [message] : [])]) {
                const messageId = item.id || item.messageId;
                if (messageId) messages.set(messageId, { ...messages.get(messageId), ...item, id: messageId });
            }
            expedition.messages = [...messages.values()];
            const index = current.findIndex(exp => exp.id === id);
            if (index < 0) current.push(expedition); else current[index] = expedition;
            changed.push(expedition);
        }
        if (!changed.length) { refreshDecisions(true); return; }
        await chrome.storage.local.set({ expeditionsData: current, expeditionsDataUpdatedAt: Date.now() });
        // A current message and cached expedition metadata are enough to act;
        // waiting for the periodic snapshot adds an unnecessary delay.
        await receiveMercenaryDecisions(mercenaryDecisions(changed), true, changed.map(exp => exp.id));
    });
    updateWrite = write.catch(() => {});
    return write;
}

export function receiveMercenaryDecisions(decisions, partial = false, replaceExpeditions = []) {
    const write = decisionWrite.then(async () => {
        const { expeditionDecisions = [] } = await chrome.storage.local.get('expeditionDecisions');
        const merged = new Map((partial ? expeditionDecisions : []).filter(d => !replaceExpeditions.includes(d.expeditionId))
            .map(d => [decisionKey(d), d]));
        for (const decision of decisions || []) {
            if (!decision.expeditionId || !decision.messageId) continue;
            const key = decisionKey(decision);
            merged.set(key, { ...merged.get(key), ...decision });
        }
        const current = [...merged.values()];
        await chrome.storage.local.set({ expeditionDecisions: current });
        for (const [key, attempt] of attempts) {
            if (!attempt.inFlight && !merged.has(key)) attempts.delete(key);
        }
        return current;
    });
    decisionWrite = write.catch(() => {});
    write.then(current => checkAutoChooseFromContent(current)).catch(() => {});
    return write;
}

function refreshDecisions(liveUpdate = false) {
    if (liveUpdate) window.postMessage({ type: 'COR3_SUBSCRIBE_EXPEDITIONS' }, '*');
    if (refreshing) {
        // The outstanding reply may describe the moment before this update.
        // Follow it with one fresh read rather than losing the notification.
        if (liveUpdate) refreshAgain = true;
        return refreshing;
    }
    lastRefreshAt = Date.now();
    refreshing = waitForGameReply('COR3_WS_EXPEDITIONS', { type: 'COR3_REQUEST_EXPEDITIONS', urgent: true },
        new AbortController().signal, reply => !!reply.requestId && Array.isArray(reply.expeditions))
        .then(async reply => {
            for (const attempt of attempts.values()) {
                if (attempt.retryAt <= Date.now()) attempt.needsRefresh = false;
            }
            await receiveMercenaryDecisions(mercenaryDecisions(reply.expeditions));
        }).catch(() => {
            for (const attempt of attempts.values()) {
                if (attempt.needsRefresh) attempt.retryAt = Date.now() + 30000;
            }
        }).finally(() => {
            refreshing = null;
            if (refreshAgain) { refreshAgain = false; refreshDecisions(); }
        });
    return refreshing;
}

async function sendChoice(decision, choice, automatic = false) {
    const key = decisionKey(decision);
    if (attempts.get(key)?.inFlight || attempts.get(key)?.confirmed) return;
    const attempt = { inFlight: true, automatic, controller: new AbortController() };
    attempts.set(key, attempt);
    try {
        const reply = await waitForGameReply('COR3_WS_DECISION_RESULT', {
            type: 'COR3_RESPOND_DECISION', expeditionId: decision.expeditionId,
            messageId: decision.messageId, selectedOption: choice.id
        }, attempt.controller.signal, result => !!result.requestId);
        if (reply.error) throw Object.assign(new Error(reply.error.message || String(reply.error)), reply.error);
        attempt.confirmed = true;
        // Confirmation also updates the popup, even if the next snapshot is delayed.
        await receiveMercenaryDecisions([{ ...decision, isResolved: true, selectedOption: choice.id }], true);
    } catch (error) {
        // A missing reply does not prove the choice failed. Read current game
        // state before considering another attempt, including after rate limits.
        attempt.retryAt = Date.now() + (isRateLimitError(error) ? 30000 : 5000);
        attempt.needsRefresh = true;
        console.log('[COR3 Helper] Mercenary choice was not confirmed. Will check again shortly.');
        throw error;
    } finally {
        attempt.inFlight = false;
    }
}

export async function checkAutoChooseFromContent(decisions) {
    await decisionWrite;
    const [saved, local] = await Promise.all([
        chrome.storage.sync.get(['decisionModifiers', 'helperMode']),
        chrome.storage.local.get(['expeditionDecisions', 'expeditionsData'])
    ]);
    const mods = saved.decisionModifiers || {};
    if (saved.helperMode || mods.autoChoose === false) return;
    // A missed push must not leave a mercenary waiting forever. This passive
    // read does not need the endpoint/launch queue used by other automations.
    if (!decisions && Date.now() - lastRefreshAt >= 30000 &&
        (local.expeditionsData || []).some(exp => ['IN_PROGRESS', 'RUNNING'].includes(exp.status))) {
        refreshDecisions();
        return;
    }
    // A newer snapshot may have resolved a choice while settings were loading.
    const current = local.expeditionDecisions ?? decisions ?? [];
    for (const decision of current) {
        if (decision._kind === 'drone' || !decision.expeditionId || !decision.messageId ||
            !decisionReady(decision, mods)) continue;
        const attempt = attempts.get(decisionKey(decision));
        if (attempt?.inFlight || attempt?.confirmed || attempt?.retryAt > Date.now()) continue;
        if (attempt?.needsRefresh) { refreshDecisions(); continue; }
        const veteran = mods.getRidOfVeterans !== false && (local.expeditionsData || []).some(exp =>
            exp.id === decision.expeditionId && String(exp.mercenary?.rank || '').toUpperCase() === 'VETERAN');
        const choice = bestDecisionOption(decision, mods, veteran);
        if (!choice) continue;
        console.log('[COR3 Helper] Mercenary auto-choice: ' + choice.label);
        // Each expedition can proceed without waiting for another expedition or drone.
        sendChoice(decision, choice, true).catch(() => {});
    }
}

export async function requestMercenaryDecision(request) {
    if (![request.expeditionId, request.messageId, request.selectedOption].every(value => typeof value === 'string' && value)) {
        throw new Error('Choose a valid mercenary option.');
    }
    await decisionWrite;
    const { expeditionDecisions = [] } = await chrome.storage.local.get('expeditionDecisions');
    const decision = expeditionDecisions.find(d => decisionKey(d) === decisionKey(request));
    const choice = decision?.decisionOptions?.find(option => option.id === request.selectedOption && !option.unavailable);
    if (!decision || decision.isResolved || !choice) throw new Error('This mercenary choice is no longer available.');
    await sendChoice(decision, choice);
}

export function setupMercenaryDecisions() {
    if (installed) return;
    installed = true;
    window.addEventListener('message', event => {
        if (event.source !== window || event.data?.type !== 'COR3_WS_ROOM_LEFT' || event.data.room !== 'expeditions') return;
        chrome.storage.sync.get(['decisionModifiers', 'helperMode']).then(saved => {
            if (!saved.helperMode && saved.decisionModifiers?.autoChoose !== false) refreshDecisions(true);
        });
    });
    // Deadlines use the game clock, even while another automation is running.
    setInterval(() => { checkAutoChooseFromContent().catch(() => {}); }, 10000);
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && (changes.decisionModifiers || changes.helperMode)) {
            if (changes.helperMode?.newValue || changes.decisionModifiers?.newValue?.autoChoose === false) {
                for (const attempt of attempts.values()) {
                    if (attempt.automatic && attempt.inFlight) attempt.controller.abort();
                }
            }
            checkAutoChooseFromContent().catch(() => {});
        }
    });
}
