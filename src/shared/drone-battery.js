export function droneChargeSeconds(battery, needed) {
    if (!Number.isFinite(battery?.current) || battery.current < 0 || !Number.isFinite(battery?.max) ||
        battery.max <= 0 || !Number.isFinite(needed) || needed < 0 || needed > battery.max) return null;
    if (battery.current >= needed) return 0;
    const rate = battery.restorePerHour;
    const hasRate = Number.isFinite(rate) && rate > 0;
    // The full-charge countdown retains progress hidden by the integer charge level.
    if (Number.isFinite(battery.restoreSeconds) && battery.restoreSeconds >= 0) {
        if (needed === battery.max) return battery.restoreSeconds;
        if (hasRate) return Math.max(0, battery.restoreSeconds - (battery.max - needed) / rate * 3600);
        return battery.restoreSeconds * (needed - battery.current) / (battery.max - battery.current);
    }
    return hasRate ? (needed - battery.current) / rate * 3600 : null;
}

export function droneBatteryLevel(battery, updatedAt, now = Date.now()) {
    if (!Number.isFinite(battery?.current)) return null;
    if (!Number.isFinite(battery.max) || battery.max <= 0 || !Number.isFinite(updatedAt)) return battery.current;
    const secondsToFull = droneChargeSeconds(battery, battery.max);
    if (secondsToFull == null) return battery.current;
    const elapsed = Math.max(0, (now - updatedAt) / 1000);
    if (elapsed >= secondsToFull) return battery.max;
    const rate = Number.isFinite(battery.restorePerHour) && battery.restorePerHour > 0
        ? battery.restorePerHour / 3600 : (battery.max - battery.current) / secondsToFull;
    const level = battery.max - (secondsToFull - elapsed) * rate;
    return Math.min(battery.max, Math.max(battery.current, Math.floor(level + 1e-9)));
}
