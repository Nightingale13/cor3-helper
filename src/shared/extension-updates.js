export const RELEASES_URL = 'https://github.com/Nightingale13/cor3-helper/releases';
export const UPDATE_ALARM = 'checkExtensionUpdates';
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let pending = null;

export function compareExtensionVersions(local, remote) {
    const a = local.split('.').map(Number), b = remote.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }
    return 0;
}

export function checkExtensionRelease(force = false) {
    if (pending) return pending;
    pending = check(force).finally(() => { pending = null; });
    return pending;
}

async function check(force) {
    const { extensionReleaseCheck: cached } = await chrome.storage.local.get('extensionReleaseCheck');
    const interval = cached?.status === 'error' ? 60 * 60 * 1000 : UPDATE_INTERVAL_MS;
    if (!force && cached?.checkedAt <= Date.now() && Date.now() - cached.checkedAt < interval) return cached;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let result;
    try {
        const response = await fetch('https://api.github.com/repos/Nightingale13/cor3-helper/releases/latest', {
            cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/vnd.github+json' }
        });
        if (response.status === 404) result = { status: 'none' };
        else {
            if (response.status === 403 || response.status === 429) throw new Error('GitHub limited the update check. Try again later.');
            if (!response.ok) throw new Error('Could not check GitHub releases. Try again later.');
            const release = await response.json();
            const match = typeof release.tag_name === 'string' && release.tag_name.match(/^v?(\d+\.\d+\.\d+)$/);
            if (!match || release.draft || release.prerelease) throw new Error('The latest release does not have a supported stable version tag.');
            result = { status: 'ok', version: match[1], tag: release.tag_name };
        }
    } catch (error) {
        result = { status: 'error', message: error.name === 'AbortError' ? 'GitHub update check timed out. Try again.' : error.message };
    } finally { clearTimeout(timeout); }
    result.checkedAt = Date.now();
    result.checkType = force ? 'manual' : 'automatic';
    await chrome.storage.local.set({ extensionReleaseCheck: result });
    await scheduleNextCheck(result).catch(() => {});
    return result;
}

async function scheduleNextCheck(result) {
    if (!chrome.alarms?.create) return;
    const interval = result.status === 'error' ? 60 * 60 * 1000 : UPDATE_INTERVAL_MS;
    const when = Math.max(Date.now() + 1000, result.checkedAt + interval);
    const alarm = await chrome.alarms.get(UPDATE_ALARM);
    if (!alarm || Math.abs(alarm.scheduledTime - when) > 1000)
        await chrome.alarms.create(UPDATE_ALARM, { when, periodInMinutes: UPDATE_INTERVAL_MS / 60000 });
}

export function setupExtensionUpdateChecks() {
    chrome.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === UPDATE_ALARM) checkExtensionRelease().then(scheduleNextCheck).catch(() => {});
    });
    // Service workers restart: the persisted check time prevents repeated calls.
    checkExtensionRelease().then(scheduleNextCheck).catch(() => {});
}
