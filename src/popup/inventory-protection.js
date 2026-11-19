import { el } from './dom-helpers.js';
import { inventoryName, matchingInventoryRules, currentInventoryRules } from '../shared/inventory-protection.js';

let rules = [];
let stash = [];
let revision = 0;
let writes = Promise.resolve();
let editingRule = null;
let pickerButtons = [];
let pickerFilter = '';
const form = document.getElementById('inventoryRuleForm');
const nameInput = document.getElementById('protectedItemName');
const mode = document.getElementById('protectedItemMode');
const minimum = document.getElementById('protectedItemMinimum');
const list = document.getElementById('inventoryProtectionRules');
const status = document.getElementById('inventoryRuleStatus');
const saveButton = document.getElementById('saveInventoryRule');
const cancelButton = document.getElementById('cancelInventoryRuleEdit');
const picker = document.getElementById('protectedItemPicker');
const browse = document.getElementById('protectedItemBrowse');
const choices = document.getElementById('protectedItemChoices');

function sameRule(a, b) {
    return b && inventoryName(a) === inventoryName(b);
}

function itemIcon(name) {
    const icon = el('span', { className: 'inventory-choice-icon', 'aria-hidden': 'true' });
    const item = [...stash, ...rules].find(item => item.imageUrl && inventoryName(item) === inventoryName({ name }));
    if (item) icon.appendChild(el('img', { src: item.imageUrl, alt: '', loading: 'lazy', decoding: 'async',
        onerror: () => { icon.textContent = '📦'; } }));
    else icon.textContent = '📦';
    return icon;
}

function showChoices(filter = '') {
    pickerFilter = filter;
    const names = [...new Set([...stash, ...rules].map(item => item.name).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b)).filter(name => inventoryName({ name }).includes(filter.toLocaleLowerCase()));
    pickerButtons = names.map((name, index) => el('button', { type: 'button', role: 'option',
        'aria-selected': String(name === nameInput.value),
        onclick: () => { nameInput.value = name; closeChoices(); nameInput.focus(); },
        onkeydown: event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); pickerButtons[(index + (event.key === 'ArrowDown' ? 1 : names.length - 1)) % names.length].focus();
            } else if (event.key === 'Escape') { event.preventDefault(); closeChoices(); nameInput.focus(); }
        } }, itemIcon(name), el('span', { className: 'inventory-choice-name' }, name)));
    choices.replaceChildren(...pickerButtons);
    if (!names.length) choices.appendChild(el('div', { className: 'helper-panel-note' }, 'No matching items. You can type a name to add a rule.'));
    choices.hidden = false;
    nameInput.setAttribute('aria-expanded', 'true'); browse.setAttribute('aria-expanded', 'true');
}

function closeChoices() {
    choices.hidden = true;
    nameInput.setAttribute('aria-expanded', 'false'); browse.setAttribute('aria-expanded', 'false');
}

function resetEditor() {
    editingRule = null; nameInput.value = ''; mode.value = 'all'; minimum.value = '1';
    minimum.hidden = true; minimum.required = false; saveButton.textContent = 'Save rule'; cancelButton.hidden = true;
    closeChoices();
}

function editRule(rule) {
    editingRule = { ...rule }; nameInput.value = rule.name || ''; mode.value = rule.minimum == null ? 'all' : 'minimum';
    minimum.value = String(rule.minimum ?? 1); minimum.hidden = mode.value !== 'minimum'; minimum.required = !minimum.hidden;
    saveButton.textContent = 'Save changes'; cancelButton.hidden = false;
    closeChoices(); form.scrollIntoView?.({ block: 'nearest' }); nameInput.focus();
    status.textContent = 'Editing protection for ' + rule.name + '.';
}

function updateRules(change) {
    const pending = writes.catch(() => {}).then(async () => {
        const saved = await chrome.storage.local.get('protectedInventoryRules');
        const next = change(currentInventoryRules(saved.protectedInventoryRules));
        revision++;
        await chrome.storage.local.set({ protectedInventoryRules: next });
        rules = next;
        renderRules();
        return true;
    });
    writes = pending;
    return pending.catch(() => { status.textContent = 'Could not save the rule. Please try again.'; return false; });
}

export function inventoryKeepMinimum(item) {
    const matching = matchingInventoryRules(item, rules).filter(rule => Number.isSafeInteger(rule.minimum));
    return matching.length ? Math.max(...matching.map(rule => rule.minimum)) : item.quantity || 1;
}

export function inventoryProtectionLabel(item) {
    const matching = matchingInventoryRules(item, rules);
    if (!matching.length) return '';
    if (matching.some(rule => rule.minimum == null)) return '🔒 Protected from automatic selling';
    return '🔒 Keeping at least ' + Math.max(...matching.map(rule => rule.minimum)) + ' copies';
}

export function saveInventoryProtection(item, count = null, previous = null) {
    const name = String(item.name || '').trim();
    if (!name || (count !== null && (!Number.isSafeInteger(count) || count < 1 || count > 999999))) return Promise.resolve(false);
    return updateRules(current => {
        status.textContent = count == null ? 'Keeping all copies of ' + name + '.' : 'Keeping at least ' + count + ' of ' + name + '.';
        const imageUrl = item.imageUrl || [...stash, ...current].find(entry => inventoryName(entry) === inventoryName({ name }) && entry.imageUrl)?.imageUrl;
        return [...current.filter(rule => !sameRule(rule, previous) && inventoryName(rule) !== inventoryName({ name })),
            { name, minimum: count, ...(imageUrl ? { imageUrl } : {}) }];
    });
}

export function updateProtectedStash(items = []) {
    stash = items;
    if (!choices.hidden) showChoices(pickerFilter);
    renderRules();
}

function renderRules() {
    list.replaceChildren(...rules.map(rule => {
        const label = rule.minimum == null ? 'Keep all copies' : 'Keep at least ' + rule.minimum;
        return el('div', { className: 'inventory-protection-rule' },
            el('div', null, el('strong', { className: 'inventory-rule-name' }, itemIcon(rule.name),
                el('span', null, rule.name || 'Protected item')), el('span', null, label)),
            el('div', { className: 'inventory-rule-actions' },
                el('button', { type: 'button', className: 'refresh-btn-small', title: 'Edit rule', 'aria-label': 'Edit protection for ' + rule.name,
                    onclick: () => editRule(rule) }, '✏️'),
                el('button', { type: 'button', className: 'refresh-btn-small inventory-rule-delete', title: 'Delete rule', 'aria-label': 'Remove protection for ' + rule.name,
                    onclick: async () => {
                        const removed = await updateRules(current => current.filter(entry => !sameRule(entry, rule)));
                        if (removed && sameRule(rule, editingRule)) resetEditor();
                    } }, '❌')));
    }));
    if (!rules.length) list.appendChild(el('p', { className: 'helper-panel-note' }, 'No rules yet. Use Keep all or Keep qty in My Stash, or add a rule above.'));
}

browse.addEventListener('click', () => { if (choices.hidden || pickerFilter) showChoices(); else closeChoices(); });
nameInput.addEventListener('input', () => showChoices(nameInput.value.trim()));
nameInput.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); showChoices(); pickerButtons[0]?.focus(); }
    else if (event.key === 'Escape') closeChoices();
});
document.addEventListener('pointerdown', event => { if (!picker.contains(event.target)) closeChoices(); });
picker.addEventListener('focusout', event => { if (!picker.contains(event.relatedTarget)) closeChoices(); });
cancelButton.addEventListener('click', () => { resetEditor(); status.textContent = ''; });
mode.addEventListener('change', () => { minimum.hidden = mode.value !== 'minimum'; minimum.required = !minimum.hidden; });
form.addEventListener('submit', async event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const count = mode.value === 'minimum' ? Number(minimum.value) : null;
    if (!name || (count !== null && (!Number.isSafeInteger(count) || count < 1 || count > 999999))) return;
    const previous = editingRule;
    saveButton.disabled = true;
    if (await saveInventoryProtection({ name }, count, previous) && editingRule === previous) resetEditor();
    saveButton.disabled = false;
});
function loadRules(saved) {
    rules = currentInventoryRules(saved);
    renderRules();
    if (rules.length !== (saved || []).length) updateRules(current => current);
}
chrome.storage.local.get('protectedInventoryRules').then(saved => { if (!revision) loadRules(saved.protectedInventoryRules); });
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.protectedInventoryRules) { revision++; loadRules(changes.protectedInventoryRules.newValue); }
});
