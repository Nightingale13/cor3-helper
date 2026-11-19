export function reportActivity(event) {
    window.postMessage({ type: 'COR3_ACTIVITY_EVENT', event }, '*');
}
