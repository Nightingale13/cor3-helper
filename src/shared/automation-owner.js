// Only the selected game tab loads content automations or writes shared caches.
// Other tabs keep observing their own game socket and wait for a handover.
export function loadAsAutomationOwner(load) {
    window.__cor3ContentOwnsAutomation = false;
    const instanceId = 'page:' + Date.now() + ':' + Math.random();
    let claiming = false;
    let started = false;
    let retry;
    return new Promise((resolve, reject) => {
        async function claim() {
            if (claiming || started) return;
            claiming = true;
            clearTimeout(retry);
            try {
                const result = await chrome.runtime.sendMessage({ action: 'claimAutomationOwner', instanceId });
                if (!result?.granted) {
                    window.postMessage({ type: 'COR3_AUTOMATION_OWNERSHIP', active: false }, '*');
                    if (result?.error || !result?.owner) retry = setTimeout(claim, 5000);
                    return;
                }
                started = true;
                window.__cor3ContentOwnsAutomation = true;
                await load();
                window.postMessage({ type: 'COR3_AUTOMATION_OWNERSHIP', active: true }, '*');
                resolve();
            } catch (error) {
                if (started) {
                    await chrome.runtime.sendMessage({ action: 'releaseAutomationOwner', instanceId }).catch(() => {});
                    reject(error);
                }
                else retry = setTimeout(claim, 5000);
            } finally { claiming = false; }
        }
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes.automationOwner) return;
            if (!started) { claim(); return; }
            if (changes.automationOwner.newValue?.instanceId !== instanceId) {
                window.__cor3ContentOwnsAutomation = false;
                window.postMessage({ type: 'COR3_AUTOMATION_OWNERSHIP', active: false }, '*');
                window.postMessage({ type: 'COR3_AUTOJOB_STOP' }, '*');
                window.postMessage({ type: 'COR3_VALUABLE_STOP' }, '*');
                if (window.__cor3ContentBootstrap) window.__cor3ContentBootstrap.ready = false;
            }
        });
        claim();
    });
}
