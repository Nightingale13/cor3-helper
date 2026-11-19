import { el } from './dom-helpers.js';
import { activityDay, emptyActivityDay, availableActivityDays } from '../shared/activity-summary.js';
import { formatJobLog } from '../shared/job-log-format.js';

const container = document.getElementById('activitySummaryContent');
const panel = document.getElementById('activitySummarySection');
const quick = document.getElementById('activityQuickSummary');
const dateSelect = document.getElementById('activityDate');
const title = document.getElementById('activitySummaryTitle');
let selectedDate = 'today';
let summary;
let revision = 0;
const money = value => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' CR';
const points = value => Number(value || 0).toLocaleString();
function cost(value, unknown) { return unknown && !value ? 'Not available' : money(value) + (unknown ? ' + ' + unknown + ' cost unavailable' : ''); }
function trend(value) { return (value > 0 ? '📈 +' : value < 0 ? '📉 ' : '➖ ') + money(value); }
function signedColour(value) { return value > 0 ? 'activity-positive' : value < 0 ? 'activity-negative' : 'activity-neutral'; }
function description(entry) {
    const name = formatJobLog(entry.name || 'Unknown job');
    const labels = { jobDone: 'Completed ' + name, jobSkipped: 'Skipped ' + name + (entry.reason ? ': ' + formatJobLog(entry.reason) : ''),
        mercenaryLaunch: 'Sent a mercenary expedition', droneLaunch: 'Launched a drone flight', droneRepair: 'Started a drone repair' };
    return labels[entry.kind] || '';
}
function render() {
    const days = availableActivityDays(summary);
    if (selectedDate !== 'today' && !days.includes(selectedDate)) selectedDate = 'today';
    dateSelect.replaceChildren(el('option', { value: 'today' }, 'Today'), ...days.map(day => el('option', { value: day },
        new Date(day + 'T12:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))));
    dateSelect.value = selectedDate;
    const day = { ...emptyActivityDay(), ...summary?.days?.[selectedDate === 'today' ? activityDay() : selectedDate] };
    // This stored counter comes from profile progress (player Renown), not market XP.
    const renown = day.marketXp;
    title.textContent = selectedDate === 'today' ? '📈 Activity Today' : '📈 Activity History';
    const net = day.creditsIn - day.creditsOut;
    quick.replaceChildren(el('span', { className: day.jobs ? 'activity-count' : 'activity-neutral' }, day.jobs + ' jobs'),
        ' · ', el('span', { className: signedColour(net) }, trend(net)));
    quick.title = 'Jobs completed and recorded net credit change for the selected day';
    const rows = [
        ['Jobs completed', day.jobs, day.jobs ? 'activity-count' : 'activity-neutral'], ['💰 Job earnings', money(day.jobEarnings), signedColour(day.jobEarnings)],
        ['⭐ Market reputation gained', points(day.reputation), day.reputation < 0 ? 'activity-negative' : day.reputation ? 'activity-reputation' : 'activity-neutral'],
        ['🏅 Renown (player XP) gained', points(renown), renown < 0 ? 'activity-negative' : renown ? 'activity-xp' : 'activity-neutral'],
        ['Credits received', money(day.creditsIn), signedColour(day.creditsIn)], ['Credits spent', money(day.creditsOut), signedColour(-day.creditsOut)],
        ['Net credit change', trend(net), signedColour(net)],
        ['Mercenary expeditions sent', day.mercenaries, day.mercenaries ? 'activity-count' : 'activity-neutral'],
        ['Mercenary launch costs', cost(day.mercenaryCost, day.mercenaryUnknown), signedColour(-day.mercenaryCost)],
        ['Drone flights launched', day.flights, day.flights ? 'activity-count' : 'activity-neutral'],
        ['Drone repair costs', cost(day.repairCost, day.repairUnknown), signedColour(-day.repairCost)],
        ['Jobs skipped or failed', day.skipped, day.skipped ? 'activity-warning' : 'activity-neutral']
    ];
    const table = el('table', { className: 'activity-metrics', 'aria-label': 'Activity for the selected day' },
        el('tbody', null, ...rows.map(([label, value, colour]) => el('tr', null, el('th', { scope: 'row' }, label), el('td', { className: colour }, String(value))))));
    const recent = el('ul', { className: 'activity-recent' }, ...day.recent.map(entry => el('li', null,
        el('time', { datetime: new Date(entry.at).toISOString() }, new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        description(entry))));
    container.replaceChildren(table, recent);
}
dateSelect.addEventListener('change', () => { selectedDate = dateSelect.value; render(); });
chrome.storage.local.get('activitySummary').then(data => { if (!revision) summary = data.activitySummary; render(); });
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.activitySummary) { revision++; summary = changes.activitySummary.newValue; render(); }
});
setInterval(render, 30000);
let expansionTouched = false;
chrome.storage.local.get('activitySummaryExpanded').then(data => { if (!expansionTouched) panel.open = data.activitySummaryExpanded === true; });
panel.addEventListener('toggle', () => { expansionTouched = true; chrome.storage.local.set({ activitySummaryExpanded: panel.open }); });
