// Lock deadlines survive automatic retries, manual starts, and market refreshes.
export function isMinigameLocked(job, now = Date.now()) {
    return !!(job && job.lockExpiresAt && new Date(job.lockExpiresAt).getTime() > now);
}
