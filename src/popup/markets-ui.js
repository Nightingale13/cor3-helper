const panel = document.getElementById('marketsSection');
const toggle = document.getElementById('marketsUiToggle');
const status = document.getElementById('marketsUiStatus');
let revision = 0;
let expansionTouched = false;

function display(enabled) {
    toggle.checked = enabled;
    panel.style.display = enabled ? '' : 'none';
    const card = panel.closest('.popout-card');
    if (card) card.style.display = enabled ? '' : 'none';
    status.textContent = enabled ? 'Shown' : 'Hidden';
    status.style.color = enabled ? 'var(--accent-green)' : 'var(--text-muted)';
}

chrome.storage.sync.get('marketsUiEnabled').then(saved => { if (!revision) display(saved.marketsUiEnabled === true); });
chrome.storage.local.get('marketsUiExpanded').then(saved => { if (!expansionTouched) panel.open = saved.marketsUiExpanded === true; });
toggle.addEventListener('change', () => {
    revision++;
    display(toggle.checked);
    chrome.storage.sync.set({ marketsUiEnabled: toggle.checked });
});
panel.addEventListener('toggle', () => { expansionTouched = true; chrome.storage.local.set({ marketsUiExpanded: panel.open }); });
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.marketsUiEnabled) { revision++; display(changes.marketsUiEnabled.newValue === true); }
});
