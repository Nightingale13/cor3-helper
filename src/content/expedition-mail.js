// Expedition rewards are mail attachments; claim.all applies to one message.
export function pendingExpeditionMessages(mail, confirmed = new Set()) {
    return pendingRewardMessages(mail, 'EXPEDITION', confirmed);
}

export function pendingRewardMessages(mail, source, confirmed = new Set()) {
    return (mail?.messages || []).filter(message => {
        if (!message.id || message.status === 'CLAIMED') return false;
        const pending = (message.attachments || []).filter(a => !a.claimedAt && !confirmed.has(a.id));
        return pending.length > 0 && pending.every(a => a.id && a.source === source);
    });
}

let nextRequestId = 0;
function abortError() {
    return new DOMException('Mail collection cancelled', 'AbortError');
}

export function waitForGameReply(type, request, signal, matches = () => true) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(abortError()); return; }
        const requestId = 'reward:' + Date.now() + ':' + (++nextRequestId);
        function cleanup() {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            signal.removeEventListener('abort', onAbort);
            window.postMessage({ type: 'COR3_CANCEL_REQUEST', requestId }, '*');
        }
        function onAbort() { cleanup(); reject(abortError()); }
        function onMessage(event) {
            if (event.source !== window || (event.data?.requestId && event.data.requestId !== requestId)) return;
            if (event.data?.type === 'COR3_REQUEST_ERROR' && event.data.requestId === requestId) {
                cleanup();
                reject(Object.assign(new Error(event.data.error?.message || 'Game request was rejected.'), event.data.error));
                return;
            }
            if (event.data?.type !== type || !matches(event.data)) return;
            cleanup();
            resolve(event.data);
        }
        const timer = setTimeout(() => {
            cleanup();
            reject(Object.assign(new Error('Timed out waiting for ' + type + '.'), {
                code: 'game_reply_timeout', replyType: type
            }));
        }, 20000);
        window.addEventListener('message', onMessage);
        signal.addEventListener('abort', onAbort, { once: true });
        window.postMessage({ ...request, requestId }, '*');
    });
}

function requestMail(signal) {
    return waitForGameReply('COR3_WS_MAIL', { type: 'COR3_REQUEST_MAIL' }, signal,
        reply => Array.isArray(reply.data?.messages)).then(reply => reply.data);
}

function requestStash(signal) {
    return waitForGameReply('COR3_WS_STASH', { type: 'COR3_REQUEST_STASH' }, signal,
        reply => Array.isArray(reply.stash?.items) && Number.isFinite(reply.stash?.maxCapacity))
        .then(reply => reply.stash);
}

export function isMailCapacityError(value) {
    if (value && typeof value === 'object') return isMailCapacityError(value.message) || isMailCapacityError(value.code);
    return typeof value === 'string' && /^(insufficient stash capacity|stash\.error\.insufficient_capacity|insufficient_capacity|insufficient_space|stash_full|inventory_full|not_enough_space|no[-_]space)$/i.test(value);
}

function collectionError(message, capacity = false) {
    const error = new Error(message);
    if (capacity) error.code = 'stash_full';
    return error;
}

function itemSlots(attachment) {
    return (attachment.width || 1) * (attachment.height || 1) *
        Math.ceil((attachment.quantity || 1) / (attachment.maxStack || 1));
}

export function collectExpeditionMail(options) {
    return collectRewardMail({ ...options, source: 'EXPEDITION' });
}

const rewardWrites = new Map();
function updateRewardState(source, update) {
    const key = 'rewardMailState:' + source;
    const write = (rewardWrites.get(source) || Promise.resolve()).then(async () => {
        const local = await chrome.storage.local.get(key);
        const next = update(local[key] || {});
        await chrome.storage.local.set({ [key]: next });
        return next;
    });
    rewardWrites.set(source, write.catch(() => {}));
    return write;
}

// Persist before finalizing the expedition: the server may deliver its mail
// even if the finalization reply is lost or the browser closes.
export function noteRewardCompletion(source, id) {
    if (!id) return Promise.resolve();
    return updateRewardState(source, state => ({ ...state,
        pending: [...new Set([...(state.pending || []), ...((state.completed || []).includes(id) ? [] : [id])])] }));
}

export async function hasRewardMailToCollect(source, allowInitialCheck = true) {
    const key = 'rewardMailState:' + source;
    await rewardWrites.get(source);
    const local = await chrome.storage.local.get([key, 'mailData']);
    const state = local[key] || {};
    const knownMail = pendingRewardMessages(local.mailData, source).some(message => !(state.mailIds || []).includes(message.id));
    return !!(state.collecting || state.pending?.length || knownMail || (allowInitialCheck && !state.checked));
}

// An empty mailbox is not a reason to keep polling it. Reopen collection only
// for a new completion, known unclaimed mail, or the first idle recovery check.
export async function collectPendingRewardMail({ source, signal, freeSpace, allowInitialCheck = true }) {
    if (!await hasRewardMailToCollect(source, allowInitialCheck)) return false;
    const state = await updateRewardState(source, current => ({ ...current, collecting: true }));
    const pending = state.pending || [];
    const mailIds = await collectRewardMail({ source, signal, freeSpace });
    await updateRewardState(source, current => ({ ...current, checked: true, collecting: false,
        pending: (current.pending || []).filter(id => !pending.includes(id)),
        completed: [...new Set([...(current.completed || []), ...pending])].slice(-100),
        mailIds: [...new Set([...(current.mailIds || []), ...mailIds])].slice(-500) }));
    return true;
}

export async function collectRewardMail({ signal, freeSpace, source }) {
    const confirmed = new Set();
    const collectedMessages = new Set();
    const capacityRetries = new Map();
    const capacityRefreshes = new Set();
    let mail = await requestMail(signal);
    for (let count = 0; count < 100; count++) {
        if (signal.aborted) throw abortError();
        const message = pendingRewardMessages(mail, source, confirmed)[0];
        if (!message) {
            await requestStash(signal);
            console.log('[COR3 Helper] Reward mailbox collected; inventory refreshed:', source);
            return [...collectedMessages];
        }
        const attachments = message.attachments.filter(a => !a.claimedAt && !confirmed.has(a.id));
        const ids = new Set(attachments.map(a => a.id));
        console.log('[COR3 Helper] Claiming reward mail:', source, message.id);
        const reply = await waitForGameReply('COR3_WS_MAIL_CLAIM_RESULT', {
            type: 'COR3_CLAIM_MAIL', messageId: message.id
        }, signal, result => result.error || result.data?.results?.some(r => ids.has(r.attachmentId)));

        const results = (reply.data?.results || []).filter(r => ids.has(r.attachmentId));
        for (const result of results) {
            if (['claimed', 'already_claimed', 'already-claimed'].includes(result.status)) confirmed.add(result.attachmentId);
        }
        const remaining = attachments.filter(a => !confirmed.has(a.id));
        if (!reply.error && remaining.length === 0) {
            collectedMessages.add(message.id);
            continue;
        }

        // A manual claim can race automation. Verify the refreshed mailbox before retrying.
        const failure = reply.error || results.find(r => !['claimed', 'already_claimed', 'already-claimed'].includes(r.status));
        mail = await requestMail(signal);
        const stillPending = pendingRewardMessages(mail, source, confirmed).find(m => m.id === message.id);
        if (!stillPending) { collectedMessages.add(message.id); continue; }
        const capacity = isMailCapacityError(failure) || isMailCapacityError(failure?.error) ||
            isMailCapacityError(failure?.reason) || isMailCapacityError(failure?.status);
        if (['not-found', 'not_found'].includes(failure?.status)) {
            throw Object.assign(new Error('Reward mail changed while collecting. Rechecking current state.'), { code: 'game_reply_timeout' });
        }
        if (!capacity) {
            const detail = typeof failure === 'string' ? failure : failure?.message || failure?.status || 'Incomplete claim response';
            throw Object.assign(collectionError('Mail claim failed: ' + detail), failure?.code ? { code: failure.code } : {});
        }

        const retries = capacityRetries.get(message.id) || 0;
        const stash = await requestStash(signal);
        const required = stillPending.attachments.filter(a => !a.claimedAt && !confirmed.has(a.id)).reduce((n, a) => n + itemSlots(a), 0);
        const available = stash.availableSpace ?? (stash.maxCapacity - stash.currentUsage);
        if (available >= required && !capacityRefreshes.has(message.id)) {
            // A stale capacity rejection can disagree with the current inventory.
            // Retry once from fresh state before treating it as fragmentation and selling.
            capacityRefreshes.add(message.id);
            mail = await requestMail(signal);
            continue;
        }
        if (!freeSpace || retries >= 3) throw collectionError('Insufficient stash capacity for reward mail.', true);
        capacityRetries.set(message.id, retries + 1);
        // If free area is sufficient, fragmentation may still prevent placement.
        await freeSpace(stash, Math.max(1, required - (available || 0)), signal);
        await requestStash(signal);
        mail = await requestMail(signal);
    }
    throw collectionError('Too many reward mail messages in one collection pass. Automation stopped.');
}
