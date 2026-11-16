// Protocol actions referenced by upstream PR #6; get.options verified against the live game.
import { wsSend } from './ws-send.js';
import { requestOptions } from './request-control.js';

const actions = ['get.options', 'launch', 'repair', 'resolve.event', 'claim', 'get.archived'];

export function handleDroneMessage(eventName, payload, outbound) {
    if (eventName !== 'drone-missions' || !payload) return false;
    var action = payload.event && payload.event.action;
    window.postMessage({ type: 'COR3_WS_DRONE_RESULT', action: action,
        requestId: outbound?.requestId, data: payload.data || null, error: payload.error || null }, '*');
    if (payload.error) return true;
    if (payload.data && payload.data.drone) {
        window.postMessage({ type: 'COR3_WS_DRONE_OPTIONS', action, data: payload.data }, '*');
    }
    if (payload.data && payload.data.id && payload.data.status) {
        window.postMessage({ type: 'COR3_WS_DRONE_MISSION', action, data: payload.data }, '*');
    }
    if (action === 'get.archived') {
        window.postMessage({ type: 'COR3_WS_DRONE_ARCHIVED', data: payload.data }, '*');
    }
    if (action === 'event' || action === 'completed') {
        window.postMessage({ type: action === 'event' ? 'COR3_WS_DRONE_EVENT' : 'COR3_WS_DRONE_COMPLETED', data: payload.data }, '*');
    }
    return true;
}

window.addEventListener('message', function (event) {
    if (event.source !== window || event.data?.type !== 'COR3_DRONE_COMMAND') return;
    if (actions.indexOf(event.data.action) < 0) return;
    wsSend('42' + JSON.stringify(['event', {
        event: { name: 'drone-missions', action: event.data.action }, data: event.data.data || {}
    }]), requestOptions(event.data.requestId));
});
