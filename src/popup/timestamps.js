import { showLastUpdated, formatTimeAgo } from './utils.js';

const dailyLastUpdated = document.getElementById('dailyLastUpdated');
const coreMarketLastUpdated = document.getElementById('coreMarketLastUpdated');
const darkMarketLastUpdated = document.getElementById('darkMarketLastUpdated');
const soyuzMarketLastUpdated = document.getElementById('soyuzMarketLastUpdated');
const usolMarketLastUpdated = document.getElementById('usolMarketLastUpdated');
const expeditionLastUpdated = document.getElementById('expeditionLastUpdated');
const decisionLastUpdated = document.getElementById('decisionLastUpdated');
const personalDroneLastUpdated = document.getElementById('personalDroneLastUpdated');
const inventoryLastUpdated = document.getElementById('inventoryLastUpdated');
const archivedExpLastUpdated = document.getElementById('archivedExpLastUpdated');
const mercenariesLastUpdated = document.getElementById('mercenariesLastUpdated');
const loadoutLastUpdated = document.getElementById('loadoutLastUpdated');

function showLatestUpdated(element, keys) {
    if (!element) return;
    chrome.storage.local.get(keys, result => {
        const timestamp = Math.max(0, ...keys.map(key => Number(result[key]) || 0));
        element.textContent = timestamp ? formatTimeAgo(timestamp) : '';
    });
}

export function refreshAllTimestamps() {
    showLastUpdated(dailyLastUpdated, 'dailyOpsUpdatedAt');
    showLastUpdated(coreMarketLastUpdated, 'marketDataUpdatedAt');
    showLastUpdated(darkMarketLastUpdated, 'darkMarketDataUpdatedAt');
    showLastUpdated(soyuzMarketLastUpdated, 'soyuzMarketDataUpdatedAt');
    showLastUpdated(usolMarketLastUpdated, 'usolMarketDataUpdatedAt');
    showLatestUpdated(expeditionLastUpdated, ['expeditionsDataUpdatedAt', 'droneDataUpdatedAt', 'droneMissionUpdatedAt']);
    showLatestUpdated(decisionLastUpdated, ['expeditionsDataUpdatedAt', 'droneMissionUpdatedAt', 'droneDataUpdatedAt']);
    showLastUpdated(personalDroneLastUpdated, 'droneDataUpdatedAt');
    if (inventoryLastUpdated) showLastUpdated(inventoryLastUpdated, 'stashDataUpdatedAt');
    if (archivedExpLastUpdated) showLatestUpdated(archivedExpLastUpdated, ['archivedExpeditionsUpdatedAt', 'droneArchivedUpdatedAt']);
    if (mercenariesLastUpdated) showLastUpdated(mercenariesLastUpdated, 'mercenariesUpdatedAt');
    if (loadoutLastUpdated) showLastUpdated(loadoutLastUpdated, 'loadoutUpdatedAt');
}
