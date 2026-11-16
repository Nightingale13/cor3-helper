// --- Storage change listeners NOT covered by individual module self-init ---
// Markets, inventory, loadout, and mercenaries already register their own
// storage listeners via initMarketStorageListener(), initInventoryStorageListener(),
// initLoadoutStorageListener(), and inline listeners in mercenaries.js.
// This module handles the remaining cases.

import { refreshAllTimestamps } from './timestamps.js';
import { loadExpeditions } from './expeditions.js';
import { loadArchivedExpeditions, archivedLootStorageKeys } from './archived-expeditions.js';
import { loadCachedDailyOps } from './daily-ops.js';

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Expedition data (not handled by expeditions.js — it only caches for veteran check)
    if (changes.expeditionsData || changes.expeditionLaunchError || changes.droneData || changes.droneMissionData || changes.droneEvents || changes.droneRetiredEvents || changes.droneDecisionError) {
        loadExpeditions();
        refreshAllTimestamps();
    }

    // Archived expeditions
    if (archivedLootStorageKeys.some(key => changes[key])) {
        loadArchivedExpeditions();
    }

    // Daily ops data
    if (changes.dailyOpsData) {
        loadCachedDailyOps();
        refreshAllTimestamps();
    }
});
