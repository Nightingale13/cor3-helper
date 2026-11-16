// These actions share game state even when they appear in different windows.
export function commandInteractionScope(name) {
    if (['network-map', 'market', 'sai'].includes(name)) return 'network';
    return ['loadout', 'desktop'].includes(name) ? name : null;
}

export function eventInteractionScope(type) {
    if (/LOADOUT/.test(type)) return 'loadout';
    if (/DESKTOP|FOLDER|FILE_ANALYSIS/.test(type)) return 'desktop';
    return 'network';
}
