// Initial data fetch orchestration on page load / reconnect.
let initialFetchStarted = false;
let generation = 0;
window.__cor3InitialMercsFetchDone = false;
window.__cor3InitialFetchInProgress = true;

window.__cor3ResetInitialFetch = function () {
    generation++;
    initialFetchStarted = false;
    window.__cor3InitialMercsFetchDone = false;
    window.__cor3InitialFetchInProgress = true;
};

window.__cor3InitialFetch = async function () {
    if (initialFetchStarted) return;
    initialFetchStarted = true;
    const current = ++generation;
    const alive = () => current === generation;
    window.__cor3InitialMercsFetchDone = false;
    window.__cor3InitialFetchInProgress = true;
    window.postMessage({ type: 'COR3_FETCH_DAILY_OPS' }, '*');
    try {
        // Passive data remains available while market navigation waits for the user.
        window.__cor3RequestExpeditions();
        window.__cor3RequestStash();
        window.__cor3RequestMail();
        window.__cor3RequestSpecialists();
        window.__cor3RequestLoadout();
        window.__cor3RequestUpdater();
        window.postMessage({ type: 'COR3_DRONE_COMMAND', action: 'get.options', data: {} }, '*');
        const request = start => new Promise(resolve => start(resolve));
        for (const fetch of [window.__cor3RequestMarket, window.__cor3RequestDarkMarket,
            window.__cor3RequestSoyuzMarket, window.__cor3RequestUsolMarket]) {
            if (!alive()) return;
            await request(fetch);
        }
        if (!alive()) return;
        window.postMessage({ type: 'COR3_WS_EXPEDITIONS_READY' }, '*');
        await request(done => window.__cor3RequestMercenaries(null, done));
        if (!alive()) return;
        window.postMessage({ type: 'COR3_CORE_MERCS_DONE' }, '*');
        await request(window.__cor3RequestUsolMercenaries);
        if (!alive()) return;
        window.__cor3InitialMercsFetchDone = true;
        window.postMessage({ type: 'COR3_USOL_MERCS_DONE' }, '*');
        window.__cor3RequestArchivedExpeditions();
        window.__cor3InitialFetchInProgress = false;
        window.postMessage({ type: 'COR3_INITIAL_FETCH_DONE' }, '*');
    } catch (error) {
        if (!alive()) return;
        initialFetchStarted = false;
        console.log('[COR3 Helper] Initial fetch interrupted; will retry:', error.message);
        window.postMessage({ type: 'COR3_INITIAL_FETCH_RETRY' }, '*');
        setTimeout(() => { if (alive()) window.__cor3InitialFetch(); }, 30000);
    }
};

window.__cor3KeepAlive = function () {
    console.log('[COR3 Helper] Keeping service worker alive!');
};
