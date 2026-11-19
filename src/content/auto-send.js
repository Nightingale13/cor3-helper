// Auto-Send Mercenary logic

import { isContextValid, _automationEnqueue, _automationFinish, _broadcastQueueStatus, getAutomationActive, setAutomationActive, getAutomationQueue } from './helpers.js';
import { collectPendingRewardMail, noteRewardCompletion, hasRewardMailToCollect, waitForGameReply } from './expedition-mail.js';
import { freeMailSpace } from './inventory-space.js';
import { userIdleTimeout as setTimeout, safeClearTimeout as clearTimeout, automationPaused } from '../shared/ws-utils.js';
import { isTransientAutomationError, automationRetrySeconds, isInsufficientCredits } from '../shared/automation-recovery.js';
import { saveProgress } from './progress.js';

export let _initialFetchDone = false; // false during initial data fetch after reconnect
export let autoSendInProgress = false;
export let autoSendAwaitingMercenaries = false;
export let autoSendAwaitingUsolMercs = false;
export let initialMercsReady = false;
export let autoSendDeferredWaiting = false;
export let autoSendExpeditionBlocked = false;
export let _autoSendUsolSkipped = false;
export let _autoSendMercRetryCount = 0;
export const MAX_MERC_RETRIES = 3;

export function setInitialFetchDone(v) { _initialFetchDone = v; }
let mailCollection = null;
let launchConfirmation = null;
let autoSendGeneration = 0;
let fundingWait = null;
let fundingTimer = null;
let fundingWarningGeneration = 0;
let responseRetries = 0;
let responseRetryTimer = null;
let responseRetryAt = 0;
let recoverySetup = false;
const FUNDING_WAIT_WARNING = 'Waiting for credits. Auto-send stays on and will retry after income or within a minute.';

function clearFundingWait() {
    clearTimeout(fundingTimer);
    fundingTimer = null;
    fundingWait = null;
    const generation = ++fundingWarningGeneration;
    // Retire only the funding warning. Selection warnings remain until resolved.
    chrome.storage.local.remove('autoSendFundingWait');
    chrome.storage.local.get('mercWarning', saved => {
        if (!fundingWait && generation === fundingWarningGeneration && saved.mercWarning === FUNDING_WAIT_WARNING)
            chrome.storage.local.remove('mercWarning');
    });
}

export async function waitForAutoSendFunds(requiredCredits = null) {
    const settings = await chrome.storage.sync.get('autoSendMerc');
    if (!settings.autoSendMerc?.enabled) return;
    clearFundingWait();
    fundingWait = { requiredCredits: Number.isFinite(requiredCredits) ? requiredCredits : null, since: Date.now(), nextRetryAt: Date.now() + 60000 };
    chrome.storage.local.set({ autoSendFundingWait: fundingWait });
    chrome.storage.local.remove('expeditionLaunchError');
    stopAutoSend(false);
    fundingTimer = setTimeout(() => resumeAutoSendAfterFunding(), 60000);
}

export async function resumeAutoSendAfterFunding(balance) {
    const waiting = fundingWait;
    if (!waiting || (Number.isFinite(balance) && waiting.requiredCredits != null && balance < waiting.requiredCredits)) return;
    const settings = await chrome.storage.sync.get('autoSendMerc');
    if (waiting !== fundingWait) return;
    if (!settings.autoSendMerc?.enabled) { clearFundingWait(); return; }
    if (!_initialFetchDone) {
        clearTimeout(fundingTimer);
        waiting.nextRetryAt = Date.now() + 60000;
        chrome.storage.local.set({ autoSendFundingWait: waiting });
        fundingTimer = setTimeout(() => resumeAutoSendAfterFunding(), 60000);
        return;
    }
    clearFundingWait();
    autoSendExpeditionBlocked = false;
    chrome.storage.local.remove('autoSendExpeditionBlocked');
    const cached = await chrome.storage.local.get('expeditionsData');
    checkAutoSendOnExpeditionData(cached.expeditionsData || []);
}
export function setAutoSendInProgress(v) {
    autoSendInProgress = v;
    if (!v) autoSendGeneration++;
    if (!v && mailCollection) mailCollection.abort();
    if (!v && launchConfirmation) launchConfirmation.abort();
}
export function setAutoSendAwaitingMercenaries(v) { autoSendAwaitingMercenaries = v; }
export function setAutoSendAwaitingUsolMercs(v) { autoSendAwaitingUsolMercs = v; }
export function setInitialMercsReady(v) { initialMercsReady = v; }
export function setAutoSendDeferredWaiting(v) { autoSendDeferredWaiting = v; }
export function setAutoSendExpeditionBlocked(v) { autoSendExpeditionBlocked = v; }
export function setAutoSendUsolSkipped(v) { _autoSendUsolSkipped = v; }
export function setAutoSendMercRetryCount(v) { _autoSendMercRetryCount = v; }

export function stopAutoSend(clearFunding = true) {
    if (clearFunding) clearFundingWait();
    if (clearFunding) {
        clearTimeout(responseRetryTimer);
        responseRetryTimer = null;
        responseRetryAt = 0;
        responseRetries = 0;
        chrome.storage.local.remove('autoSendRecovery');
    }
    if (clearFunding) chrome.storage.sync.get('autoSendMerc', saved => {
        if (!saved.autoSendMerc?.enabled) chrome.storage.local.remove('mercWarning');
    });
    setAutoSendInProgress(false);
    autoSendAwaitingMercenaries = false;
    autoSendAwaitingUsolMercs = false;
    _automationFinish('auto-send');
}

async function retryAfterResponseFailure(error) {
    const saved = await chrome.storage.sync.get(['autoSendMerc', 'helperMode']);
    if (!saved.autoSendMerc?.enabled || saved.helperMode) { stopAutoSend(); return; }
    const seconds = automationRetrySeconds(++responseRetries);
    responseRetryAt = Date.now() + seconds * 1000;
    autoSendExpeditionBlocked = false;
    await chrome.storage.local.remove('autoSendExpeditionBlocked');
    await chrome.storage.local.remove('expeditionLaunchError');
    await chrome.storage.local.set({ autoSendRecovery: { attempt: responseRetries, nextRetryAt: responseRetryAt,
        message: 'Waiting for a game response. Retrying automatically.', replyType: error.replyType || null } });
    // Release the shared queue during backoff. A retry always reads current
    // expedition/mail state before repeating a payment, claim, or launch.
    stopAutoSend(false);
    clearTimeout(responseRetryTimer);
    responseRetryTimer = setTimeout(() => {
        responseRetryTimer = null;
        responseRetryAt = 0;
        chrome.storage.local.get('expeditionsData', local => checkAutoSendOnExpeditionData(local.expeditionsData || []));
    }, seconds * 1000);
}

export async function recoverAutoSendTimeout() {
    const saved = await chrome.storage.sync.get(['autoSendMerc', 'helperMode']);
    const local = await chrome.storage.local.get('expeditionLaunchError');
    // Retire only the timeout pause written by older builds, not a manual stop
    // or a real capacity/payment error.
    if (saved.helperMode || saved.autoSendMerc?.enabled || !['mail_error', 'launch_error'].includes(saved.autoSendMerc?.disabledReason) ||
        !isTransientAutomationError({ message: local.expeditionLaunchError?.error })) return;
    const latest = await chrome.storage.sync.get(['autoSendMerc', 'helperMode']);
    if (latest.helperMode || latest.autoSendMerc?.enabled || latest.autoSendMerc?.disabledReason !== saved.autoSendMerc.disabledReason) return;
    await chrome.storage.sync.set({ autoSendMerc: { ...latest.autoSendMerc, enabled: true, disabledReason: null } });
    await chrome.storage.local.remove('expeditionLaunchError');
}

export function setupAutoSendRecovery() {
    if (recoverySetup) return;
    recoverySetup = true;
    const resume = async () => {
        if (!isContextValid()) return;
        await recoverAutoSendTimeout();
        if (!_initialFetchDone) return;
        clearTimeout(responseRetryTimer);
        responseRetryTimer = null;
        responseRetryAt = 0;
        const local = await chrome.storage.local.get('expeditionsData');
        checkAutoSendOnExpeditionData(local.expeditionsData || []);
    };
    window.addEventListener('online', resume);
    window.addEventListener('message', event => {
        if (event.source === window && event.data?.type === 'COR3_INITIAL_FETCH_DONE') resume();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.helperMode?.newValue || changes.autoSendMerc?.newValue?.enabled === false) stopAutoSend();
        else if (changes.autoSendMerc && changes.autoSendMerc.oldValue?.keepCreditReserve !== changes.autoSendMerc.newValue?.keepCreditReserve)
            resumeAutoSendAfterFunding();
    });
    recoverAutoSendTimeout().catch(error => console.log('[COR3 Helper] Auto-send recovery deferred:', error.message));
}

async function collectMailBeforeNextMerc(finished = []) {
    const controller = new AbortController();
    const generation = autoSendGeneration;
    mailCollection = controller;
    try {
        for (const expedition of finished) await noteRewardCompletion('EXPEDITION', expedition.id);
        const current = await waitForGameReply('COR3_WS_EXPEDITIONS', { type: 'COR3_REQUEST_EXPEDITIONS' }, controller.signal,
            reply => Array.isArray(reply.expeditions) && reply.expeditions.every(e => e.id && e.status));
        if (current.expeditions.some(e => e.status !== 'COMPLETED' && e.status !== 'FAILED')) {
            stopAutoSend();
            return;
        }
        for (const expedition of current.expeditions) {
            await noteRewardCompletion('EXPEDITION', expedition.id);
            if (expedition.containerOpenedAt) continue;
            console.log('[COR3 Helper] Paying expedition balance and sending rewards to mail:', expedition.id);
            saveProgress('mercenaries', 'Paying and collecting expedition rewards');
            const settled = await waitForGameReply('COR3_WS_EXPEDITION_SETTLED', {
                type: 'COR3_PAY_EXPEDITION_TO_MAIL', expeditionId: expedition.id
            }, controller.signal, reply => reply.error || reply.data?.id === expedition.id);
            if (settled.error) {
                throw Object.assign(new Error('Pay and send to mail failed: ' + (settled.error.message || settled.error.code || 'Unknown error')), {
                    code: isInsufficientCredits(settled.error)
                        ? 'insufficient_credits' : settled.error.code || 'settlement_error',
                    requiredCredits: expedition.remainingAmount
                });
            }
            if (!settled.data.containerOpenedAt || !settled.data.completedAt) {
                throw Object.assign(new Error('The expedition payment was not confirmed. Rechecking current state.'), { code: 'game_reply_timeout' });
            }
        }
        if (await hasRewardMailToCollect('EXPEDITION')) {
            saveProgress('mercenaries', 'Collecting completed expedition rewards');
            await collectPendingRewardMail({ source: 'EXPEDITION', signal: controller.signal, freeSpace: freeMailSpace });
        }
        saveProgress('mercenaries', 'Checking available mercenaries');
        const latest = await waitForGameReply('COR3_WS_EXPEDITIONS', { type: 'COR3_REQUEST_EXPEDITIONS' }, controller.signal,
            reply => Array.isArray(reply.expeditions) && reply.expeditions.every(e => e.id && e.status));
        if (controller.signal.aborted) return;
        // A manual launch can happen while mail is being collected.
        if (latest.expeditions.length) { stopAutoSend(); return; }
        responseRetryAt = 0;
        chrome.storage.local.remove('autoSendRecovery');
        console.log('[COR3 Helper] Expedition mail collected, refreshing mercenaries (CORE + USOL)...');
        autoSendAwaitingMercenaries = false;
        autoSendAwaitingUsolMercs = true;
        setTimeout(() => {
            if (!autoSendInProgress || generation !== autoSendGeneration || controller.signal.aborted || !isContextValid()) return;
            window.postMessage({ type: 'COR3_REQUEST_MERCENARIES' }, '*');
        }, 2500 + Math.floor(Math.random() * 1000));
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.log('[COR3 Helper] Expedition mail collection stopped:', error.message);
        const settings = await chrome.storage.sync.get('autoSendMerc');
        if (controller.signal.aborted) return;
        if (error.code === 'insufficient_credits') {
            await waitForAutoSendFunds(error.requiredCredits);
            return;
        }
        if (isTransientAutomationError(error)) { await retryAfterResponseFailure(error); return; }
        if (settings.autoSendMerc) {
            await chrome.storage.sync.set({ autoSendMerc: {
                ...settings.autoSendMerc, enabled: false,
                disabledReason: ['stash_full', 'insufficient_credits'].includes(error.code) ? error.code : 'mail_error'
            } });
        }
        chrome.storage.local.set({ expeditionLaunchError: {
            error: error.message, timestamp: Date.now(), noRetry: true
        } });
        stopAutoSend();
    } finally {
        if (mailCollection === controller) mailCollection = null;
    }
}

export function checkAutoSendOnExpeditionData(expeditions) {
    if (autoSendInProgress) return;
    if (responseRetryAt > Date.now()) return;
    if (!expeditions || !Array.isArray(expeditions) || fundingWait || !isContextValid()) {
        _automationFinish('auto-send');
        return;
    }
    if (!_initialFetchDone) {
        console.log('[COR3 Helper] Auto-send: deferred — initial data fetch still in progress');
        _automationFinish('auto-send');
        return;
    }
    if (automationPaused() && !getAutomationActive()) {
        _automationEnqueue('auto-send', () => chrome.storage.local.get('expeditionsData').then(local =>
            checkAutoSendOnExpeditionData(local.expeditionsData || [])));
        return;
    }
    if (autoSendExpeditionBlocked) {
        var hasActive = expeditions.some(e => e.status !== 'COMPLETED' && e.status !== 'FAILED');
        if (hasActive) {
            console.log('[COR3 Helper] Auto-send: still blocked — active expedition in progress');
            _automationFinish('auto-send');
            return;
        }
        console.log('[COR3 Helper] Auto-send: active expedition finished — unblocking');
        autoSendExpeditionBlocked = false;
        chrome.storage.local.remove('autoSendExpeditionBlocked');
    }
    const _automationActive = getAutomationActive();
    const _automationQueue = getAutomationQueue();
    if (_automationActive && _automationActive.type !== 'auto-send') {
        if (!_automationQueue.some(q => q.type === 'auto-send')) {
            console.log('[COR3 Helper] Auto-send: queued (waiting for', _automationActive.type, 'to finish)');
            _automationQueue.push({ type: 'auto-send', run: function () {
                chrome.storage.local.get('expeditionsData', (result) => {
                    if (result.expeditionsData) {
                        checkAutoSendOnExpeditionData(result.expeditionsData);
                    } else {
                        _automationFinish('auto-send');
                    }
                });
            }});
            _broadcastQueueStatus();
        } else {
            console.log('[COR3 Helper] Auto-send: already queued (waiting for', _automationActive.type, ')');
        }
        return;
    }
    chrome.storage.sync.get(['autoSendMerc', 'helperMode'], (settings) => {
        if (autoSendInProgress) return;
        if (fundingWait || !_initialFetchDone || settings.helperMode || !settings.autoSendMerc?.enabled ||
            (!settings.autoSendMerc.mercenaryId && settings.autoSendMerc.autoChooseMerc === false)) {
            _automationFinish('auto-send');
            return;
        }
        // Another automation may have acquired the queue during the settings read.
        if (getAutomationActive() && getAutomationActive().type !== 'auto-send') {
            checkAutoSendOnExpeditionData(expeditions);
            return;
        }

        clearFundingWait();
        chrome.storage.local.remove('autoSendRecovery');

        const hasActiveExpeditions = expeditions.some(e => e.status !== 'COMPLETED' && e.status !== 'FAILED');
        if (!hasActiveExpeditions) {
            if (!initialMercsReady) {
                if (autoSendDeferredWaiting) {
                    console.log('[COR3 Helper] Auto-send: Already waiting for initial mercs — skipping duplicate deferral');
                    _automationFinish('auto-send');
                    return;
                }
                autoSendDeferredWaiting = true;
                console.log('[COR3 Helper] Auto-send: No active expeditions but initial mercs not ready — deferring');
                function onInitialMercsDone(evt) {
                    if (evt.data && evt.data.type === 'COR3_USOL_MERCS_DONE') {
                        window.removeEventListener('message', onInitialMercsDone);
                        clearTimeout(deferTimeout);
                        autoSendDeferredWaiting = false;
                        console.log('[COR3 Helper] Auto-send: Initial mercs now ready — re-checking expeditions');
                        initialMercsReady = true;
                        chrome.storage.local.get('expeditionsData', (result) => {
                            if (result.expeditionsData) {
                                checkAutoSendOnExpeditionData(result.expeditionsData);
                            }
                        });
                    }
                }
                window.addEventListener('message', onInitialMercsDone);
                var deferTimeout = setTimeout(() => {
                    window.removeEventListener('message', onInitialMercsDone);
                    autoSendDeferredWaiting = false;
                    initialMercsReady = true;
                    console.log('[COR3 Helper] Auto-send: Deferred merc wait timed out — proceeding');
                    chrome.storage.local.get('expeditionsData', (result) => {
                        if (result.expeditionsData) {
                            checkAutoSendOnExpeditionData(result.expeditionsData);
                        }
                    });
                }, 60000);
                _automationFinish('auto-send');
                return;
            }
            console.log('[COR3 Helper] Auto-send: collecting expedition mail before selecting the next mercenary');
            autoSendInProgress = true;
            chrome.storage.local.remove('expeditionLaunchError');
            if (!getAutomationActive()) setAutomationActive({ type: 'auto-send', startedAt: Date.now() });
            _broadcastQueueStatus();
            collectMailBeforeNextMerc(expeditions);
            return;
        }
        _automationFinish('auto-send');
    });
}

export function proceedWithMerc(mercId, allMercs, settings, localData) {
    if (!mercId) {
        console.log('[COR3 Helper] Auto-send: no mercenary selected, aborting');
        autoSendInProgress = false;
        _automationFinish('auto-send');
        return;
    }
    const selectedMerc = allMercs.find(m => m.id === mercId);
    if (!selectedMerc || selectedMerc.status !== 'AVAILABLE') {
        console.log('[COR3 Helper] Auto-send: selected mercenary not AVAILABLE (status: ' + (selectedMerc ? selectedMerc.status : 'not found') + '), aborting');
        autoSendInProgress = false;
        _automationFinish('auto-send');
        return;
    }
    const isUsol = selectedMerc._market === 'usol' || (selectedMerc.faction && selectedMerc.faction.key === 'usol_employment');
    const configKey = isUsol ? 'usolExpeditionConfigData' : 'expeditionConfigData';
    const marketId = isUsol ? '019e4065-6ae8-760d-8724-58ab4f2cf7d7' : '019d3ea4-85bd-7389-904d-8f7c85841134';
    const config = localData[configKey];
    if (!config || !config.locations || config.locations.length === 0) {
        console.log('[COR3 Helper] Auto-send: no expedition config available for ' + (isUsol ? 'USOL' : 'CORE') + ', aborting');
        autoSendInProgress = false;
        _automationFinish('auto-send');
        return;
    }
    const DEFAULT_LOCATION_NAMES = ['Skylift Remains', 'Koute Mining and Reprocessing Outpost'];
    let loc = config.locations.find(l => DEFAULT_LOCATION_NAMES.includes(l.name));
    if (!loc) loc = config.locations[0];
    const zone = loc.zones && loc.zones[0] ? loc.zones[0] : null;
    const goal = zone && zone.goals && zone.goals[0] ? zone.goals[0] : null;
    if (!zone || !goal) {
        console.log('[COR3 Helper] Auto-send: missing zone/goal config, aborting');
        autoSendInProgress = false;
        _automationFinish('auto-send');
        return;
    }
    // Insurance is an optional launch modifier only. It must never affect which
    // mercenary is selected or whether an otherwise-valid launch proceeds.
    const mercConfig = localData.mercConfigData?.[mercId];
    const insuranceEnabled = settings.autoSendMerc.insureHighRisk !== false;
    const isHighRisk = String(mercConfig?.riskLevel ?? '').trim().toUpperCase() === 'HIGH';
    const hasInsurance = insuranceEnabled && isHighRisk && !!mercConfig?.isInsuranceAvailable;
    const launchConfig = {
        mercenaryId: mercId,
        marketId: marketId,
        locationConfigId: loc.id,
        zoneConfigId: zone.id,
        goalId: goal.id,
        hasInsurance
    };
    if (insuranceEnabled) {
        if (isHighRisk) {
            console.log('[COR3 Helper] Auto-send: high-risk mercenary detected; insurance', hasInsurance ? 'enabled' : 'unavailable');
        } else {
            console.log('[COR3 Helper] Auto-send: mercenary is not high risk; launching without insurance');
        }
    }
    console.log('[COR3 Helper] Auto-send: launching expedition with mercenary:', selectedMerc.callsign, '(' + (isUsol ? 'USOL' : 'CORE') + ')');
    saveProgress('mercenaries', 'Sending the selected mercenary', { name: selectedMerc.callsign });
    const generation = autoSendGeneration;
    setTimeout(async () => {
        const current = await chrome.storage.sync.get(['autoSendMerc', 'helperMode']);
        if (!autoSendInProgress || generation !== autoSendGeneration || !current.autoSendMerc?.enabled || current.helperMode || !isContextValid()) return;
        chrome.storage.local.set({ lastExpeditionLaunchData: launchConfig });
        const controller = new AbortController();
        launchConfirmation = controller;
        try {
            const reply = await waitForGameReply('COR3_WS_EXPEDITION_LAUNCH_RESULT', {
                type: 'COR3_LAUNCH_EXPEDITION', config: launchConfig,
                keepCreditReserve: current.autoSendMerc.keepCreditReserve !== false
            }, controller.signal, result => !!result.requestId);
            if (reply.error) throw Object.assign(new Error(reply.error.message || reply.error.code || 'Launch rejected.'), { code: reply.error.code });
            if (!reply.data?.id || !reply.data?.status) throw Object.assign(new Error('The launch was not confirmed.'), { code: 'game_reply_timeout' });
            autoSendExpeditionBlocked = true;
            await chrome.storage.local.set({ autoSendExpeditionBlocked: true });
            responseRetries = 0;
            await chrome.storage.local.remove(['autoSendRecovery', 'expeditionLaunchError', 'mercWarning']);
            stopAutoSend();
        } catch (error) {
            if (controller.signal.aborted || error.name === 'AbortError') return;
            if (isInsufficientCredits(error)) { await waitForAutoSendFunds(error.requiredCredits); return; }
            if (/Maximum 1 active expedition allowed|Mercenary is not available/i.test(error.message)) error.code = 'game_reply_timeout';
            if (isTransientAutomationError(error)) { await retryAfterResponseFailure(error); return; }
            const latest = await chrome.storage.sync.get('autoSendMerc');
            if (controller.signal.aborted || !latest.autoSendMerc?.enabled) return;
            await chrome.storage.sync.set({ autoSendMerc: { ...latest.autoSendMerc, enabled: false, disabledReason: 'launch_error' } });
            await chrome.storage.local.set({ expeditionLaunchError: { error: error.message, timestamp: Date.now(), noRetry: true } });
            stopAutoSend();
        } finally {
            if (launchConfirmation === controller) launchConfirmation = null;
        }
    }, 1500 + Math.floor(Math.random() * 500));
}
