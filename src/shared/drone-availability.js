export const DRONE_AVAILABILITY_CHECK_MS = 5 * 60 * 1000;

export function isDroneUnavailableError(error) {
    const code = String(error?.code || '').toLowerCase().replace(/_/g, '-');
    if (['drone-locked', 'drone-not-unlocked', 'drone-not-available', 'drone-not-owned', 'drone-not-found'].includes(code)) return true;
    const message = (error?.message || '').trim().replace(/^(?:(?:Drone automation paused|Something went wrong)[:.]\s*)+/i, '');
    return /^(?:Personal )?drone (?:is |has )?(?:not (?:yet )?(?:unlocked|available|owned)|not been unlocked)[.!]?$/i.test(message);
}
