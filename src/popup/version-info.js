import { _safeSetHtml } from './dom-helpers.js';
import { getCor3Tab } from './utils.js';

const RELEASES_URL = 'https://github.com/Nightingale13/cor3-helper/releases';
const LATEST_RELEASE_API = 'https://api.github.com/repos/Nightingale13/cor3-helper/releases/latest';
const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const updateResult = document.getElementById('updateResult');

function compareVersions(local, remote) {
    const a = local.split('.').map(Number), b = remote.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }
    return 0;
}

checkUpdateBtn.addEventListener('click', async () => {
    if (checkUpdateBtn.disabled) return;
    checkUpdateBtn.disabled = true;
    updateResult.textContent = 'Checking GitHub releases…';
    updateResult.style.color = 'var(--text-dim)';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(LATEST_RELEASE_API, { cache: 'no-store', signal: controller.signal,
            headers: { Accept: 'application/vnd.github+json' } });
        if (response.status === 404) {
            _safeSetHtml(updateResult, `No public stable release is available for this fork. <a href="${RELEASES_URL}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan);">View releases</a>`);
            return;
        }
        if (response.status === 403 || response.status === 429)
            throw new Error('GitHub limited the update check. Try again later.');
        if (!response.ok) throw new Error('Could not check GitHub releases. Try again later.');
        const release = await response.json();
        const match = typeof release.tag_name === 'string' && release.tag_name.match(/^v?(\d+\.\d+\.\d+)$/);
        if (!match || release.draft || release.prerelease)
            throw new Error('The latest release does not have a supported stable version tag.');
        const remoteVersion = match[1];
        const localVersion = chrome.runtime.getManifest().version;
        const comparison = compareVersions(localVersion, remoteVersion);
        if (comparison < 0) {
            const releaseUrl = `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`;
            _safeSetHtml(updateResult, `Extension update available: <b>v${localVersion}</b> → <b>v${remoteVersion}</b><br><a href="${releaseUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan);">Download release from GitHub</a><br><span style="font-size:9px;color:var(--text-muted);">Download dist.zip, extract, and reload the extension on chrome://extensions.</span>`);
            updateResult.style.color = 'var(--accent-orange)';
        } else {
            updateResult.textContent = comparison === 0 ? `You're up to date (v${localVersion}).`
                : `Installed v${localVersion}; latest published release is v${remoteVersion}.`;
            updateResult.style.color = comparison === 0 ? 'var(--accent-green)' : 'var(--text-dim)';
        }
    } catch (error) {
        console.log('[COR3 Helper] Check for updates error:', error);
        cor3LogError('popup.js', error, { action: 'checkForUpdates' });
        updateResult.textContent = error.name === 'AbortError' ? 'GitHub update check timed out. Try again.' : error.message;
        updateResult.style.color = 'var(--accent-red)';
    } finally {
        clearTimeout(timeout);
        checkUpdateBtn.disabled = false;
    }
});

async function displayVersionInfo(retryCount) {
    retryCount = retryCount || 0;
    const versionSection = document.getElementById('versionInfoSection');
    if (!versionSection) return;
    const extVersion = chrome.runtime.getManifest().version;
    const { webVersion, systemVersion, patchVersion } = await chrome.storage.local.get(['webVersion', 'systemVersion', 'patchVersion']);

    let finalWebVersion = webVersion;
    let finalSystemVersion = systemVersion;
    let finalPatchVersion = patchVersion;

    if (!webVersion || !systemVersion || !patchVersion) {
        try {
            const tab = await getCor3Tab();
            if (tab) {
                const response = await chrome.tabs.sendMessage(tab.id, { action: "getVersionFallbacks" });
                if (response) {
                    if (!finalWebVersion && response.webVersion) {
                        finalWebVersion = response.webVersion;
                        chrome.storage.local.set({ webVersion: response.webVersion });
                    }
                    if (!finalSystemVersion && response.systemVersion) {
                        finalSystemVersion = response.systemVersion;
                        chrome.storage.local.set({ systemVersion: response.systemVersion });
                    }
                    if (!finalPatchVersion && response.patchVersion) {
                        finalPatchVersion = response.patchVersion;
                        chrome.storage.local.set({ patchVersion: response.patchVersion });
                    }
                }
            }
        } catch (e) {
            console.log('[COR3 Helper] Could not get version fallbacks:', e);
        }
    }

    let parts = [`Extension: v${extVersion}`];
    if (finalWebVersion) parts.push(`Game web: ${finalWebVersion}`);
    if (finalSystemVersion) parts.push(`System: ${finalSystemVersion}`);
    if (finalPatchVersion) parts.push(`Patch: ${finalPatchVersion}`);
    versionSection.textContent = parts.join(' · ');
    versionSection.style.display = 'block';

    if ((!finalWebVersion || !finalSystemVersion || !finalPatchVersion) && retryCount < 5) {
        setTimeout(() => displayVersionInfo(retryCount + 1), 2000);
    }
}
displayVersionInfo(0);

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.webVersion || changes.systemVersion || changes.patchVersion) displayVersionInfo();
});
