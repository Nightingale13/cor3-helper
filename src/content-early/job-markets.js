import { wsSend } from './ws-send.js';
import { validMarketId } from './request-tracker.js';

let pendingRead = null;

export function requestJobMarketRead(request) {
    if (!['get.options', 'get.jobs'].includes(request.action) || !request.requestId) return;
    if (!validMarketId(request.marketId)) {
        reply(request, null, { message: 'Market ID is missing or invalid' });
        return;
    }
    pendingRead = request;
    wsSend('42' + JSON.stringify(['event', { event: { name: 'market', action: request.action }, data: { marketId: request.marketId } }]), {
        requestId: request.requestId,
        cancelled: () => pendingRead !== request,
        onSent: () => window.postMessage({ type: 'COR3_AUTOJOB_MARKET_SENT', requestId: request.requestId }, '*'),
        onReject: error => { if (pendingRead === request) { pendingRead = null; reply(request, null, error); } }
    });
}

export function cancelJobMarketRead(requestId) {
    if (pendingRead?.requestId === requestId) pendingRead = null;
}

function reply(request, data, error) {
    window.postMessage({ type: 'COR3_AUTOJOB_MARKET_RESULT', marketId: request.marketId,
        requestId: request.requestId, action: request.action, data, error: error || null }, '*');
}

export function relayJobMarketRead(payload, outbound) {
    const request = pendingRead;
    if (!request || outbound?.source !== 'helper' || outbound.requestId !== request.requestId ||
        payload?.event?.action !== request.action) return;
    if (outbound.ambiguous) {
        pendingRead = null;
        reply(request, null, { code: 'manual-context-changed' });
        return;
    }
    if (payload.data?.market?.id && payload.data.market.id !== request.marketId) return;
    if (!payload.error && !payload.data) return;
    pendingRead = null;
    reply(request, payload.data, payload.error);
}
