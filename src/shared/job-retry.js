import { isTransientAutomationError, isInsufficientCredits } from './automation-recovery.js';

// Lock deadlines survive automatic retries, manual starts, and market refreshes.
export function isMinigameLocked(job, now = Date.now()) {
    return !!(job && job.lockExpiresAt && new Date(job.lockExpiresAt).getTime() > now);
}

export function isRetryableJobError(error) {
    return isTransientAutomationError(error) || isInsufficientCredits(error) ||
        /timed? out|timeout|internal[-_ ](?:server[-_ ])?error/i.test(error?.message || '');
}

export function isRetryableJobResult(result) {
    return result?.status === 'failed' && isRetryableJobError({ message: result.error, code: result.errorCode });
}
