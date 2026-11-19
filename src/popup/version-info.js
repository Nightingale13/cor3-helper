import { _safeSetHtml } from './dom-helpers.js';
import { getCor3Tab } from './utils.js';
import { RELEASES_URL, compareExtensionVersions, checkExtensionRelease } from '../shared/extension-updates.js';

const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const updateResult = document.getElementById('updateResult');
let latestCheckAt = 0;

function renderReleaseCheck(result) {
    if (!result) return;
    // The initial cached read can finish after a live background update.
    // Keep the latest actual check visible in that case.
    const checkedAt = Number(result.checkedAt) || 0;
    if (checkedAt < latestCheckAt) return;
    latestCheckAt = checkedAt;
    updateResult.style.color = 'var(--text-secondary)';
    if (result.status === 'none') {
        _safeSetHtml(updateResult, `No public stable release is available for this fork. <a href="${RELEASES_URL}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan);">View releases</a>`);
    } else if (result.status === 'error') {
        updateResult.textContent = result.message;
        updateResult.style.color = 'var(--accent-red)';
    } else if (result.status === 'ok') {
        const local = chrome.runtime.getManifest().version;
        const comparison = compareExtensionVersions(local, result.version);
        if (comparison < 0) {
            const url = `${RELEASES_URL}/tag/${encodeURIComponent(result.tag)}`;
            _safeSetHtml(updateResult, `Extension update available: <b>v${local}</b> → <b>v${result.version}</b><br><a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan);">Download release from GitHub</a><span class="update-instructions">Download dist.zip, extract, and reload the extension on chrome://extensions.</span>`);
            updateResult.style.color = 'var(--accent-orange)';
        } else {
            updateResult.textContent = comparison === 0 ? `You're up to date (v${local}).`
                : `Installed v${local}; latest published release is v${result.version}.`;
            updateResult.style.color = comparison === 0 ? 'var(--accent-green)' : 'var(--text-secondary)';
        }
    }
    const checkType = ['automatic', 'manual'].includes(result.checkType) ? ' (' + result.checkType + ')' : '';
    const lastChecked = checkedAt ? 'Last checked: ' + new Date(checkedAt).toLocaleString() + checkType : '';
    updateResult.title = lastChecked;
    const info = document.getElementById('updateCheckInfo');
    if (info) info.textContent = 'Checks automatically every 24 hours.' + (lastChecked ? ' ' + lastChecked : '');
}

checkUpdateBtn.addEventListener('click', async () => {
    if (checkUpdateBtn.disabled) return;
    checkUpdateBtn.disabled = true;
    updateResult.textContent = 'Checking GitHub releases…';
    try { renderReleaseCheck(await checkExtensionRelease(true)); }
    catch (error) {
        updateResult.textContent = 'Could not complete the update check. Try again.';
        updateResult.style.color = 'var(--accent-orange)';
    }
    finally { checkUpdateBtn.disabled = false; }
});
chrome.storage.local.get('extensionReleaseCheck').then(data => renderReleaseCheck(data.extensionReleaseCheck));

async function displayVersionInfo(retryCount) {
    retryCount = retryCount || 0;
    const versionSection = document.getElementById('versionInfoSection');
    if (!versionSection) return;
    const extVersion = chrome.runtime.getManifest().version;
    const { webVersion, systemVersion, patchVersion, gameVersionSession } = await chrome.storage.local.get(['webVersion', 'systemVersion', 'patchVersion', 'gameVersionSession']);
    let session = gameVersionSession;

    let finalWebVersion = webVersion;
    let finalSystemVersion = systemVersion;
    let finalPatchVersion = patchVersion;

    {
        try {
            const tab = await getCor3Tab();
            if (tab) {
                const response = await chrome.tabs.sendMessage(tab.id, { action: "getVersionFallbacks" });
                if (response) {
                    session = response.gameVersionSession || session;
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

    if (session) {
        finalWebVersion = session.current.web ?? finalWebVersion;
        finalSystemVersion = session.current.system ?? finalSystemVersion;
        finalPatchVersion = session.current.patch ?? finalPatchVersion;
    }
    let parts = [`Extension: v${extVersion}`];
    if (finalWebVersion) parts.push(`Game web: ${finalWebVersion}`);
    if (finalSystemVersion) parts.push(`System: ${finalSystemVersion}`);
    if (finalPatchVersion) parts.push(`Patch: ${finalPatchVersion}`);
    const changes = session ? Object.entries(session.current).filter(([kind, value]) => session.initial[kind] !== value)
        .map(([kind, value]) => `${{ web: 'Game web', system: 'System', patch: 'Patch' }[kind]}: ${session.initial[kind]} → ${value}`) : [];
    versionSection.textContent = parts.join(' · ') + (changes.length ? '\nChanged since opening: ' + changes.join(' · ') : '');
    versionSection.style.whiteSpace = 'pre-line';
    versionSection.title = 'Game web: the loaded game website. System: the systemVersion reported for your game account. Patch: the patch selected in the game updater. Values update when the game reports them; they are not a check for new helper releases.';
    versionSection.style.display = 'block';

    if ((!finalWebVersion || !finalSystemVersion || !finalPatchVersion) && retryCount < 5) {
        setTimeout(() => displayVersionInfo(retryCount + 1), 2000);
    }
}
displayVersionInfo(0);

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.extensionReleaseCheck) renderReleaseCheck(changes.extensionReleaseCheck.newValue);
    if (changes.webVersion || changes.systemVersion || changes.patchVersion || changes.gameVersionSession) displayVersionInfo();
});
