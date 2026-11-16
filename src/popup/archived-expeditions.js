import { _h, _noData, _clearEl, _safeSetHtml } from './dom-helpers.js';
import { getCor3Tab, waitForStorageKey, formatTimeAgo } from './utils.js';
import { refreshAllTimestamps } from './timestamps.js';
import { combinedExpeditionHistory } from '../shared/drone-history.js';
import { createLootTierResolver } from '../shared/loot-tier.js';
import { itemTierClass, itemTierLabel } from '../shared/item-tier.js';

export const archivedLootStorageKeys = ['archivedExpeditionsData', 'droneArchivedData', 'stashData',
    'marketData', 'darkMarketData', 'soyuzMarketData', 'usolMarketData'];

const archivedExpSectionToggle = document.getElementById('archivedExpSectionToggle');
const archivedExpSectionBody = document.getElementById('archivedExpSectionBody');
const archivedExpContainer = document.getElementById('archivedExpContainer');
const refreshArchivedBtn = document.getElementById('refreshArchivedBtn');

archivedExpSectionToggle.addEventListener('click', () => {
    archivedExpSectionToggle.classList.toggle('open');
    archivedExpSectionBody.classList.toggle('open');
});

async function requestArchivedExpeditions() {
    archivedExpContainer.replaceChildren(_noData('Loading archived expeditions...'));
    try {
        const tab = await getCor3Tab();
        if (tab) {
            await chrome.tabs.sendMessage(tab.id, { action: "requestArchivedExpeditions" });
            await chrome.tabs.sendMessage(tab.id, { action: "requestDroneArchived" });
        }
    } catch (e) { /* not reachable */ }
    setTimeout(() => loadArchivedExpeditions(), 3000);
}

if (refreshArchivedBtn) {
    refreshArchivedBtn.addEventListener('click', () => requestArchivedExpeditions());
}

export async function loadArchivedExpeditions() {
    const storage = await chrome.storage.local.get(archivedLootStorageKeys);
    renderArchivedExpeditions(combinedExpeditionHistory(storage.archivedExpeditionsData, storage.droneArchivedData), createLootTierResolver(storage));
    refreshAllTimestamps();
}

function renderArchivedExpeditions(data, resolveTier) {
    if (!archivedExpContainer) return;
    _clearEl(archivedExpContainer);

    let items = data;
    if (data && !Array.isArray(data) && data.items) items = data.items;
    if (data && !Array.isArray(data) && data.data) items = data.data;

    if (!items || !Array.isArray(items) || items.length === 0) {
        archivedExpContainer.replaceChildren(_noData('No archived expeditions found.'));
        return;
    }
    for (const exp of items) {
        if (exp._kind === 'drone') {
            archivedExpContainer.appendChild(droneArchiveCard(exp, resolveTier));
            continue;
        }
        const card = document.createElement('div');
        card.className = 'archived-exp-card';

        const factionDisplay = (exp.mercenary && exp.mercenary.faction) ? ((exp.mercenary.faction.name || '').replace('factions.', '').replace(/([A-Z])/g, ' $1').trim().split(" ")[0].toUpperCase()) : 'UNEMPLOYED';
        const mercName = exp.mercenary ? exp.mercenary.callsign : 'Unknown';
        const outcome = (exp.outcome || exp.status || 'COMPLETED').toUpperCase();
        let outcomeClass = 'outcome-full';
        if (outcome.includes('PARTIAL')) outcomeClass = 'outcome-partial';
        else if (outcome.includes('FAIL')) outcomeClass = 'outcome-fail';
        else if (outcome.includes('DEATH')) outcomeClass = 'outcome-death';

        let html = `<div class="archived-exp-header">`;
        html += `<span class="archived-exp-merc">🧑 ${mercName}</span>`;
        html += `<span class="outcome-tag ${outcomeClass}">${outcome}</span>`;
        html += `</div>`;
        html += `<div class="archived-exp-info">`;
        html += `Faction: <b>${factionDisplay}</b>`;
        html += `<br>`;
        if ((exp.locationName && exp.zoneName) && (exp.locationName.length + exp.zoneName.length) > 30) {
            html += `📍 ${exp.locationName || '--'} /`;
            html += `<br>`;
            html +=  `${exp.zoneName || '--'}`;
        } else {
            html += `📍 ${exp.locationName || '--'} / ${exp.zoneName || '--'}`;
        }
        if (exp.objectiveName) html += ` — ${exp.objectiveName}`;
        html += `<br>`;
        if (exp.totalCost !== undefined) html += `💰 Cost: ${exp.totalCost.toLocaleString()} · `;
        if (exp.riskScore !== undefined) html += `⚠️ Risk: ${exp.riskScore}`;
        html += `</div>`;

        const rawContainer = exp.containerData || exp.container;
        const containerItems = Array.isArray(rawContainer) ? rawContainer
            : (rawContainer && Array.isArray(rawContainer.items) ? rawContainer.items : null);
        if (containerItems && containerItems.length > 0) {
            const uid = 'archived_' + exp.id;
            html += `<div class="container-items">`;
            html += `<div class="expandable-header" data-expand="${uid}"><span class="expand-arrow">▶</span><span class="expand-label">Loot (${containerItems.length} items)</span></div>`;
            html += `<div class="expandable-body" id="${uid}">`;
            for (const ci of containerItems) {
                const det = ci.item || ci;
                const imgSrc = det.imageUrl || det.image || '';
                const imgTag = imgSrc ? `<img src="${imgSrc}" style="width:24px;height:24px;border-radius:4px;vertical-align:middle;margin-right:4px;" loading="lazy">` : '';
                const tierTag = det.tier ? ` <span class="tier-tag tier-tag-${itemTierClass(det.tier)}">${itemTierLabel(det.tier)}</span>` : '';
                let statusTag = '';
                if (det.isCollected) statusTag = ' <span style="color:var(--accent-green);font-size:9px;">✓ Collected</span>';
                else if (det.isDeleted) statusTag = ' <span style="color:var(--accent-red);font-size:9px;">✗ Deleted</span>';
                html += `<div style="font-size:10px;margin:2px 0;">${imgTag}${det.name || det.id || '?'}${tierTag}${statusTag}</div>`;
            }
            html += `</div></div>`;
        }
        if (exp.completedAt) {
            const agoMs = Date.now() - new Date(exp.completedAt).getTime();
            let agoText = '';
            if (agoMs < 60000) agoText = 'just now';
            else if (agoMs < 3600000) agoText = Math.floor(agoMs / 60000) + 'm ago';
            else if (agoMs < 86400000) { const h = Math.floor(agoMs / 3600000); const m = Math.floor((agoMs % 3600000) / 60000); agoText = h + 'h' + (m > 0 ? ' ' + m + 'm' : '') + ' ago'; }
            else { const d = Math.floor(agoMs / 86400000); const h = Math.floor((agoMs % 86400000) / 3600000); agoText = d + 'd' + (h > 0 ? ' ' + h + 'h' : '') + ' ago'; }
            html += `<span style="font-size:9px;color:var(--text-dim);display:flex;flex-direction:row-reverse;">🕐 Completed ${agoText}</span>`;
        }

        _safeSetHtml(card, html);
        archivedExpContainer.appendChild(card);
    }
    archivedExpContainer.querySelectorAll('.expandable-header').forEach(hdr => {
        hdr.addEventListener('click', () => {
            hdr.classList.toggle('open');
            const targetId = hdr.getAttribute('data-expand');
            const body = document.getElementById(targetId);
            if (body) body.classList.toggle('openExtended');
        });
    });
}

function droneArchiveCard(mission, resolveTier) {
    const outcome = String(mission.outcome || mission.status || 'COMPLETED').toUpperCase();
    const outcomeClass = /FAIL|DESTROY|DEATH/.test(outcome) ? 'outcome-fail' : /PARTIAL/.test(outcome) ? 'outcome-partial' : 'outcome-full';
    const card = _h('div', { className: 'archived-exp-card', dataset: { expeditionType: 'drone' } },
        _h('div', { className: 'archived-exp-header' },
            _h('span', { className: 'archived-exp-merc' }, '🛩️ Drone — ' + (mission.drone?.name || mission.droneName || mission.mission?.name || mission.missionName || 'Expedition')),
            _h('span', { className: 'outcome-tag ' + outcomeClass }, outcome)),
        _h('div', { className: 'archived-exp-info' },
            '📍 ' + (mission.location?.name || mission.locationName || '--'), _h('br'),
            'Mission: ' + (mission.mission?.name || mission.missionName || '--')));
    const details = [];
    if (Number.isFinite(mission.batteryCost)) details.push('Battery: ' + mission.batteryCost);
    if (Number.isFinite(mission.finalRisk ?? mission.riskScore)) details.push('Risk: ' + (mission.finalRisk ?? mission.riskScore));
    if (Number.isFinite(mission.damageDealt)) details.push('Damage: ' + mission.damageDealt);
    if (details.length) card.appendChild(_h('div', { className: 'archived-exp-info' }, details.join(' · ')));
    if (Array.isArray(mission.loot) && mission.loot.length) {
        const id = 'archived_drone_' + mission.id;
        card.appendChild(_h('div', { className: 'container-items' },
            _h('div', { className: 'expandable-header', 'data-expand': id }, _h('span', { className: 'expand-arrow' }, '▶'),
                _h('span', { className: 'expand-label' }, 'Loot (' + mission.loot.length + ' items)')),
            _h('div', { className: 'expandable-body', id }, ...mission.loot.map(loot => {
                const item = loot.item || loot;
                const tier = resolveTier(loot);
                return _h('div', { style: 'font-size:10px;margin:2px 0;' },
                    item.imageUrl ? _h('img', { src: item.imageUrl, loading: 'lazy', alt: '', style: 'width:24px;height:24px;border-radius:4px;vertical-align:middle;margin-right:4px;' }) : null,
                    item.name || item.shortName || item.itemConfigId || item.id || 'Item',
                    tier ? ' ' : null,
                    tier ? _h('span', { className: 'tier-tag tier-tag-' + itemTierClass(tier) }, itemTierLabel(tier)) : null,
                    (loot.quantity ?? item.quantity) > 1 ? ' ×' + (loot.quantity ?? item.quantity) : null);
            }))));
    }
    const completed = new Date(mission.completedAt || mission.endTime).getTime();
    if (Number.isFinite(completed)) card.appendChild(_h('span', { style: 'font-size:9px;color:var(--text-dim);display:flex;flex-direction:row-reverse;' },
        '🕐 Completed ' + formatTimeAgo(completed).replace(/^Updated /, '')));
    return card;
}

export async function refreshArchivedOnly() {
    archivedExpContainer.replaceChildren(_noData('Loading archived expeditions...'));
    try {
        const tab = await getCor3Tab();
        if (tab) {
            await chrome.tabs.sendMessage(tab.id, { action: "requestArchivedExpeditions" });
            await chrome.tabs.sendMessage(tab.id, { action: "requestDroneArchived" });
        }
    } catch (e) {}
    await waitForStorageKey('archivedExpeditionsData', 5000);
    await loadArchivedExpeditions();
    refreshAllTimestamps();
}

loadArchivedExpeditions();
