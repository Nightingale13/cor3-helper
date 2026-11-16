import { el } from './dom-helpers.js';
import { getCor3Tab, showLastUpdated } from './utils.js';
import { droneSettings, pickDroneMission } from '../shared/drone-policy.js';
import { dronePanelStatus } from '../shared/drone-status.js';
import { droneBatteryLevel } from '../shared/drone-battery.js';
import { droneDurabilityLevel } from '../shared/drone-timing.js';
import { state } from './state.js';

const toggle = document.getElementById('personalDroneSectionToggle');
const body = document.getElementById('personalDroneSectionBody');
const container = document.getElementById('personalDroneContainer');
const refresh = document.getElementById('refreshDroneBtn');
let cfg = droneSettings();
let data = null;
let automationStatus = null;
let repairWhileCharging;
let dataUpdatedAt = null;
let batteryUpdatedAt = null;
let repairUpdatedAt = null;
let statusChip = null;
let chargeChip = null;
let repairPlan = null;
let activeMission = null;
let completedMission = null;
let automationQueue = null;
let batteryValue = null;
let durabilityValue = null;
const pair = (current, max) => Number.isFinite(current) ? current + (Number.isFinite(max) ? ' / ' + max : '') : '—';

function updateDroneStatus() {
    const now = Date.now();
    if (batteryValue) batteryValue.textContent = pair(droneBatteryLevel(data?.battery, batteryUpdatedAt, now), data?.battery?.max);
    if (durabilityValue) durabilityValue.textContent = pair(droneDurabilityLevel(data, repairUpdatedAt, repairPlan, now), data?.drone?.maxDurability);
    const view = dronePanelStatus({ options: data, settings: cfg, updatedAt: dataUpdatedAt, batteryUpdatedAt, repairUpdatedAt,
        repairPlan, repairWhileCharging, mission: activeMission, completed: completedMission,
        automationStatus, queue: automationQueue, helperMode: state.isHelper }, now);
    if (statusChip) {
        statusChip.textContent = view.text;
        statusChip.title = view.detail;
        statusChip.className = 'merc-status ' + view.className;
    }
    if (chargeChip) {
        chargeChip.textContent = view.secondaryText || '';
        chargeChip.style.display = view.secondaryText ? '' : 'none';
        chargeChip.title = view.detail;
    }
    status.textContent = view.detail;
    status.className = cfg.paused ? 'warning-banner' : 'merc-info drone-note';
}
function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const minutes = Math.ceil(seconds / 60);
    return minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm' : minutes + 'm';
}
const controls = [];
const editors = [];
const stats = el('div');
const status = el('div', { role: 'status', className: 'merc-info drone-note' });
const missionDetails = el('div', { className: 'merc-info drone-note' });
const repairDetails = el('div', { className: 'drone-note' });

async function save(patch) {
    if (state.isHelper) return false;
    const saved = await chrome.storage.sync.get('autoDrone');
    cfg = droneSettings({ ...saved.autoDrone, ...patch });
    await chrome.storage.sync.set({ autoDrone: cfg });
    render();
    return true;
}

function switchRow(label, key, title = '') {
    const id = 'drone-' + key;
    const input = el('input', { type: 'checkbox', id, 'aria-label': label });
    const row = el('div', { className: 'auto-choose-row', title },
        el('label', { for: id }, label),
        el('div', { style: 'display:flex;align-items:center;gap:8px;' },
            el('label', { className: 'alarm-toggle-switch' }, input, el('span', { className: 'slider-track' }))));
    controls.push({ input, key, row });
    input.addEventListener('change', () => save({ [key]: input.checked, ...(key === 'enabled' ? { paused: false } : {}) }));
    return row;
}

// Use the same pencil -> Save / Cancel interaction as the mercenary cost limit.
function numberSetting(label, key, min, max) {
    const value = el('strong');
    const edit = el('button', { type: 'button', className: 'refresh-btn-small', title: 'Edit ' + label.toLowerCase(), 'aria-label': 'Edit ' + label.toLowerCase() }, '✏️');
    const display = el('div', { className: 'drone-number-row' },
        el('span', { style: 'color:var(--text-muted);' }, label + ': ', value, '%'),
        el('span', { className: 'drone-edit-actions' }, edit));
    const input = el('input', { type: 'number', min, max, step: 1, id: 'drone-' + key, style: 'width:70px;', 'aria-label': label + ' percent' });
    const saveButton = el('button', { type: 'button', className: 'refresh-btn-small' }, '💾 Save');
    const cancel = el('button', { type: 'button', className: 'refresh-btn-small' }, 'Cancel');
    const error = el('div', { role: 'alert', className: 'drone-number-error' });
    const editRow = el('div', { className: 'drone-number-row', style: 'display:none;' },
        el('label', null, label + ' (%): ', input),
        el('span', { className: 'drone-edit-actions' }, saveButton, cancel), error);
    const editor = { key, editing: false, display, editRow, input, value, edit, saveButton, cancel };
    function close() {
        editor.editing = false;
        error.textContent = '';
        render();
    }
    edit.addEventListener('click', () => {
        if (state.isHelper) return;
        editor.editing = true;
        input.value = cfg[key];
        render();
        input.focus();
        input.select();
    });
    async function commit() {
        const number = Number(input.value);
        if (input.value.trim() === '' || !Number.isInteger(number) || number < min || number > max) {
            error.textContent = 'Enter a whole percentage from ' + min + ' to ' + max + '.';
            return;
        }
        const low = key === 'repairThreshold' ? number : cfg.repairThreshold;
        const high = key === 'repairTarget' ? number : cfg.repairTarget;
        if (low >= high) {
            error.textContent = 'The repair threshold must be below the repair target.';
            return;
        }
        if (await save({ [key]: number })) close();
    }
    saveButton.addEventListener('click', commit);
    cancel.addEventListener('click', close);
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    editors.push(editor);
    return el('div', null, display, editRow);
}

const location = el('select', { id: 'drone-location', 'aria-label': 'Drone location' });
const mission = el('select', { id: 'drone-mission', 'aria-label': 'Drone mission' });
location.addEventListener('change', () => save({ locationConfigId: location.value, missionConfigId: '' }));
mission.addEventListener('change', () => save({ locationConfigId: location.value, missionConfigId: mission.value }));
const resume = el('button', { type: 'button', className: 'refresh-btn-small', onclick: () => save({ paused: false }) }, 'Resume automation');
const resumeRow = el('div', { className: 'drone-note' }, resume);
refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    status.textContent = 'Refreshing drone…';
    try {
        const tab = await getCor3Tab();
        if (!tab) throw new Error('Open cor3.gg to refresh drone data.');
        await chrome.tabs.sendMessage(tab.id, { action: 'requestDroneOptions' });
    } catch (error) { status.textContent = error.message; }
    finally { refresh.disabled = false; }
});

container.classList.add('drone-panel');
container.replaceChildren(
    numberSetting('Minimum durability before repair', 'repairThreshold', 0, 99),
    numberSetting('Repair target', 'repairTarget', 1, 100),
    switchRow('Auto-send drone after expedition ends', 'enabled'),
    switchRow('Auto-choose lowest battery cost mission', 'autoChooseMission', 'Choose the lowest battery cost, then lowest base risk, then shortest duration.'),
    switchRow('Wait for full battery before launching', 'fullCharge'),
    switchRow('Auto-repair at the durability limit', 'autoRepair'),
    switchRow('Repair while charging', 'repairWhileCharging', 'Use the remaining charging time to repair towards full durability. Charging repairs can exceed the normal repair target.'),
    el('div', { className: 'drone-config-row' }, el('label', { for: 'drone-location' }, 'Location:'), location),
    el('div', { className: 'drone-config-row' }, el('label', { for: 'drone-mission' }, 'Mission:'), mission),
    missionDetails, status, resumeRow, stats, repairDetails,
    el('div', { className: 'drone-note' }, 'Upgrade modules: manage the six slots in game.')
);

function selectOptions(select, entries, selected) {
    select.replaceChildren(...entries.map(entry => el('option', { value: entry.id }, entry.name)));
    select.value = entries.some(entry => entry.id === selected) ? selected : entries[0]?.id || '';
}

function render() {
    controls.forEach(({ input, key, row }) => {
        input.checked = !!cfg[key]; input.disabled = state.isHelper;
        row.style.display = state.isHelper ? 'none' : '';
    });
    editors.forEach(editor => {
        if (state.isHelper) editor.editing = false;
        editor.value.textContent = cfg[editor.key];
        editor.display.style.display = editor.editing || state.isHelper ? 'none' : '';
        editor.editRow.style.display = editor.editing ? '' : 'none';
        if (!editor.editing) editor.input.value = cfg[editor.key];
        [editor.edit, editor.input, editor.saveButton, editor.cancel].forEach(control => { control.disabled = state.isHelper; });
    });
    resume.disabled = state.isHelper;
    resumeRow.style.display = cfg.enabled && cfg.paused && !state.isHelper ? '' : 'none';
    stats.replaceChildren();
    statusChip = null;
    chargeChip = null;
    batteryValue = null;
    durabilityValue = null;
    if (data?.drone) {
        const drone = data.drone;
        const chip = el('span');
        statusChip = chip;
        chargeChip = el('span', { className: 'merc-status resting', style: 'margin-left:4px;' });
        durabilityValue = el('b', { id: 'drone-durability-value' });
        batteryValue = el('b', { id: 'drone-battery-value' });
        stats.append(el('div', { className: 'merc-card drone-card' },
            el('div', { className: 'merc-details' },
                el('div', { className: 'merc-name' }, drone.name || 'Personal drone'),
                el('div', { style: 'margin-top:4px;margin-bottom:4px;display:flex;flex-wrap:wrap;gap:4px;' }, chip, chargeChip),
                el('div', { className: 'merc-info' }, 'Durability: ', durabilityValue,
                    ' · Battery: ', batteryValue, el('br'),
                    'Stealth: ', el('b', null, pair(drone.stealth)), ' · Payload: ',
                    el('b', null, Number.isFinite(drone.payloadGrams) ? (drone.payloadGrams / 1000).toLocaleString() + ' kg' : '—')))));
    } else stats.append(el('div', { className: 'no-decisions' }, 'No drone data yet. Click 🔄 to refresh.'));
    const locations = data?.locations || [];
    selectOptions(location, locations, cfg.locationConfigId);
    selectOptions(mission, locations.find(l => l.id === location.value)?.missions || [], cfg.missionConfigId);
    location.disabled = mission.disabled = state.isHelper || cfg.autoChooseMission;
    const selected = pickDroneMission(data, cfg);
    missionDetails.textContent = selected ? 'Battery cost: ' + selected.batteryCost + ' · Duration: ' + duration(selected.durationSeconds) +
        (Number.isFinite(selected.baseRisk) ? ' · Base risk: ' + selected.baseRisk : '') : 'No mission with a known battery cost selected.';
    const drone = data?.drone;
    if (drone && Number.isFinite(drone.maxDurability) && Number.isFinite(drone.durability) && data.repairRate) {
        const points = Math.max(0, Math.ceil(drone.maxDurability * cfg.repairTarget / 100) - drone.durability);
        repairDetails.textContent = 'Normal repairs: start at ' + cfg.repairThreshold + '% durability and aim for ' + cfg.repairTarget + '%.';
        if (!drone.isRepairing && points > 0) repairDetails.textContent += ' Estimate to target: ' +
            (points * data.repairRate.creditsPerPoint).toLocaleString() + ' CR · ' + duration(points * data.repairRate.secondsPerPoint) + '.';
        if (cfg.repairWhileCharging) repairDetails.textContent += ' Charging repairs can go beyond this target.';
    } else repairDetails.textContent = '';
    updateDroneStatus();
    showLastUpdated(document.getElementById('personalDroneLastUpdated'), 'droneDataUpdatedAt');
}

toggle.addEventListener('click', () => {
    toggle.classList.toggle('open'); body.classList.toggle('open');
});
chrome.storage.sync.get(['autoDrone', 'helperMode'], result => { cfg = droneSettings(result.autoDrone); state.isHelper = !!result.helperMode; render(); });
const droneStatusStorageKeys = ['droneData', 'droneDataUpdatedAt', 'droneBatteryUpdatedAt', 'droneRepairUpdatedAt', 'droneStatus', 'droneRepairWhileCharging',
    'droneRepairPlan', 'droneMissionData', 'droneCompleted', 'automationQueueStatus'];
chrome.storage.local.get(droneStatusStorageKeys, result => {
    data = result.droneData; dataUpdatedAt = result.droneDataUpdatedAt ?? Date.now();
    batteryUpdatedAt = result.droneBatteryUpdatedAt ?? dataUpdatedAt;
    repairUpdatedAt = result.droneRepairUpdatedAt ?? dataUpdatedAt;
    automationStatus = result.droneStatus; repairWhileCharging = result.droneRepairWhileCharging;
    repairPlan = result.droneRepairPlan; activeMission = result.droneMissionData;
    completedMission = result.droneCompleted; automationQueue = result.automationQueueStatus; render();
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.helperMode) state.isHelper = !!changes.helperMode.newValue;
    if (area === 'sync' && changes.autoDrone) cfg = droneSettings(changes.autoDrone.newValue);
    if (area === 'local' && changes.droneData) {
        const previousBattery = data?.battery;
        const sameBattery = data?.drone?.id === changes.droneData.newValue?.drone?.id &&
            data?.activeMissionId === changes.droneData.newValue?.activeMissionId &&
            ['current', 'max', 'restorePerHour', 'restoreSeconds'].every(key => previousBattery?.[key] === changes.droneData.newValue?.battery?.[key]);
        const previousDrone = data?.drone;
        const nextDrone = changes.droneData.newValue?.drone;
        const sameRepair = ['id', 'durability', 'maxDurability', 'isRepairing', 'repairSecondsRemaining'].every(key => previousDrone?.[key] === nextDrone?.[key]) &&
            ['startDurability', 'targetDurability', 'totalSeconds', 'secondsRemaining'].every(key => previousDrone?.repair?.[key] === nextDrone?.repair?.[key]);
        data = changes.droneData.newValue;
        dataUpdatedAt = changes.droneDataUpdatedAt?.newValue ?? Date.now();
        if (!sameBattery) batteryUpdatedAt = dataUpdatedAt;
        if (!sameRepair) repairUpdatedAt = dataUpdatedAt;
    }
    if (area === 'local' && changes.droneDataUpdatedAt) dataUpdatedAt = changes.droneDataUpdatedAt.newValue;
    if (area === 'local' && changes.droneBatteryUpdatedAt) batteryUpdatedAt = changes.droneBatteryUpdatedAt.newValue;
    if (area === 'local' && changes.droneRepairUpdatedAt) repairUpdatedAt = changes.droneRepairUpdatedAt.newValue;
    if (area === 'local' && changes.droneStatus) automationStatus = changes.droneStatus.newValue;
    if (area === 'local' && changes.droneRepairWhileCharging) repairWhileCharging = changes.droneRepairWhileCharging.newValue;
    if (area === 'local' && changes.droneRepairPlan) repairPlan = changes.droneRepairPlan.newValue;
    if (area === 'local' && changes.droneMissionData) activeMission = changes.droneMissionData.newValue;
    if (area === 'local' && changes.droneCompleted) completedMission = changes.droneCompleted.newValue;
    if (area === 'local' && changes.automationQueueStatus) automationQueue = changes.automationQueueStatus.newValue;
    if ((area === 'sync' && (changes.autoDrone || changes.helperMode)) ||
        (area === 'local' && droneStatusStorageKeys.some(key => changes[key]))) render();
});

setInterval(updateDroneStatus, 1000);

