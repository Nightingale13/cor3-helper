import { automationRetrySeconds } from './automation-recovery.js';

export function isDroneStateRecheckError(error) {
    const message = (error?.message || '').replace(/^Drone automation paused:\s*/, '');
    return /^(?:Durability data is unavailable|Repair price or duration is unavailable|Battery data is unavailable)\. Refresh before resuming\.$/.test(message) ||
        /^Drone (?:repair was not confirmed\.|launch was not confirmed by the active mission state\.|[\w.]+ returned no confirmation\.)$/.test(message);
}

export function isDroneResponseTimeout(error) {
    return error?.code === 'game_reply_timeout' ||
        /^(?:Drone automation paused:\s*)?Timed out waiting for COR3_WS_(?:DRONE_RESULT|MAIL|MAIL_CLAIM_RESULT|STASH)\./.test(error?.message || '');
}

export function droneRetrySeconds(attempt) {
    return automationRetrySeconds(attempt);
}

export function isDroneRewardCollectionError(error) {
    const message = (error?.message || '').replace(/^Drone automation paused:\s*/, '');
    return error?.rewardCollection === true || error?.code === 'stash_full' ||
        /^(?:Mail claim failed: |Insufficient stash capacity for reward mail\.|Stash is full\. Clear inventory before claiming reward mail\.|Insufficient sellable items to make room for reward mail\.|Too many reward mail messages in one collection pass\.)/.test(message);
}
