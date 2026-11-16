import { safeTimeout, safeClearTimeout } from '../shared/ws-utils.js';
import { state, sendCmd } from './state.js';

let nextRequestId = 0;

export function readJobMarket(marketId, action) {
    if (state.abortFlag) return Promise.reject(new Error('Aborted'));
    return new Promise((resolve, reject) => {
        const requestId = Date.now() + ':' + (++nextRequestId);
        let timeout, abortTimer;
        function cleanup() {
            safeClearTimeout(timeout);
            safeClearTimeout(abortTimer);
            window.removeEventListener('message', onReply);
            sendCmd('market.read.cancel', { requestId });
        }
        function onReply(event) {
            const reply = event.data;
            if (event.source === window && reply?.type === 'COR3_AUTOJOB_MARKET_SENT' && reply.requestId === requestId) {
                safeClearTimeout(timeout);
                timeout = safeTimeout(() => { cleanup(); reject(new Error('Market ' + action + ' timed out')); }, 10000);
                return;
            }
            if (event.source !== window || reply?.type !== 'COR3_AUTOJOB_MARKET_RESULT' ||
                reply.requestId !== requestId || reply.marketId !== marketId || reply.action !== action) return;
            cleanup();
            if (state.abortFlag) reject(new Error('Aborted'));
            else if (reply.error?.code === 'manual-context-changed') resolve(readJobMarket(marketId, action));
            else if (reply.error) reject(new Error(reply.error.message || reply.error.code || String(reply.error)));
            else if (!reply.data || (action === 'get.options' && reply.data.market?.id !== marketId))
                reject(new Error('Market access was not confirmed'));
            else resolve(reply.data);
        }
        function checkAbort() {
            if (state.abortFlag) { cleanup(); reject(new Error('Aborted')); }
            else abortTimer = safeTimeout(checkAbort, 500, false);
        }
        window.addEventListener('message', onReply);
        timeout = safeTimeout(() => { cleanup(); reject(new Error('Market request is waiting for a connection')); }, 60000);
        abortTimer = safeTimeout(checkAbort, 500, false);
        sendCmd('market.read', { marketId, action, requestId });
    });
}
