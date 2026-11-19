export function commandProgress(command) {
    const labels = {
        'get.map': 'Checking routes and server maintenance', 'set.endpoint': 'Connecting to the server',
        'get.login.status': 'Checking server access', 'login.with-access': 'Logging in to the server',
        'hack.start': 'Hacking the server', 'job.take': 'Accepting the job', 'job.complete': 'Claiming the job reward',
        'loadout.get': 'Checking the loadout', 'loadout.equip.hardware': 'Equipping hardware',
        'loadout.equip.software': 'Equipping software', 'loadout.unequip.software': 'Changing the software loadout',
        'decrypt.file': 'Decrypting the file', 'file.download': 'Downloading the file', 'file.upload': 'Uploading the file',
        'file.delete': 'Removing the file', 'market.read': 'Refreshing market information',
        'sai.get.files': 'Scanning server files', 'sai.get.logs': 'Scanning server logs',
        'get.files': 'Reading server files', 'get.logs': 'Reading server logs',
        'file.search-valuable': 'Searching for valuable files', 'log.search-valuable': 'Searching for valuable logs',
        'get.sellable-items': 'Checking market offers', 'sell.items': 'Selling valuable items',
        'log.download': 'Downloading the log', 'open.folder': 'Opening the folder', 'get.file.analysis': 'Checking the file'
    };
    return labels[command] || null;
}

export function reportProgress(feature, message, job, nextAt = null) {
    window.postMessage({ type: 'COR3_AUTOMATION_PROGRESS', feature,
        progress: { message, jobName: job?.name || job?.type || '', serverName: job?.serverName || '', at: Date.now(), nextAt } }, '*');
}
