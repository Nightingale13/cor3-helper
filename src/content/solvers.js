// Solver injection/stop — decrypt, ICE wall, simple decrypt, daily hack

// --- Auto Decrypt Solver ---
let decryptSolverInjected = false;

export function injectDecryptSolver() {
    if (decryptSolverInjected) {
        window.postMessage({ type: 'COR3_START_DECRYPT_SOLVER' }, '*');
        return;
    }
    decryptSolverInjected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('decrypt-solver.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
}

export function stopDecryptSolver() {
    window.postMessage({ type: 'COR3_STOP_DECRYPT_SOLVER' }, '*');
    decryptSolverInjected = false;
}

// --- Auto Daily Hack Solver ---
let dailyHackInjected = false;

export function injectDailyHackSolver() {
    if (dailyHackInjected) return;
    dailyHackInjected = true;
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('daily-hack-solver.js');
        const timeout = setTimeout(() => failed('Timed out loading daily hack solver.'), 10000);
        function failed(message) {
            clearTimeout(timeout);
            script.remove();
            dailyHackInjected = false;
            reject(new Error(message));
        }
        script.onload = () => { clearTimeout(timeout); script.remove(); resolve(); };
        script.onerror = () => failed('Could not load daily hack solver.');
        (document.head || document.documentElement).appendChild(script);
    });
}

export function stopDailyHackSolver() {
    window.postMessage({ type: 'COR3_STOP_DAILY_HACK' }, '*');
}

export function dailyHackSolverFinished() {
    dailyHackInjected = false;
}

// --- Auto ICE Wall Solver ---
let iceWallSolverInjected = false;

export function injectIceWallSolver() {
    if (iceWallSolverInjected) {
        window.postMessage({ type: 'COR3_START_ICE_WALL_SOLVER' }, '*');
        return;
    }
    iceWallSolverInjected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('ice-wall-solver.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
}

export function stopIceWallSolver() {
    window.postMessage({ type: 'COR3_STOP_ICE_WALL_SOLVER' }, '*');
    iceWallSolverInjected = false;
}

// --- Auto Simple Decrypt Solver ---
let simpleDecryptSolverInjected = false;

export function injectSimpleDecryptSolver() {
    if (simpleDecryptSolverInjected) {
        window.postMessage({ type: 'COR3_START_SIMPLE_DECRYPT_SOLVER' }, '*');
        return;
    }
    simpleDecryptSolverInjected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('simple-decrypt-solver.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
}

export function stopSimpleDecryptSolver() {
    window.postMessage({ type: 'COR3_STOP_SIMPLE_DECRYPT_SOLVER' }, '*');
    simpleDecryptSolverInjected = false;
}

// --- Auto Job Solver Engine Injection ---
const engineLoads = new Map();

function loadEngine(file) {
    if (engineLoads.has(file)) return engineLoads.get(file);
    const loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL(file);
        const timeout = setTimeout(() => { script.remove(); reject(new Error('Timed out loading ' + file)); }, 10000);
        script.onload = () => { clearTimeout(timeout); script.remove(); resolve(); };
        script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('Could not load ' + file)); };
        (document.head || document.documentElement).appendChild(script);
    });
    const result = loading.catch(error => { if (engineLoads.get(file) === result) engineLoads.delete(file); throw error; });
    engineLoads.set(file, result);
    return result;
}

export function injectAutoJobSolver() {
    return loadEngine('auto-job-solver.js');
}

// --- Auto Valuable Seller Engine Injection ---
export function injectAutoValuableSeller() {
    return loadEngine('auto-valuable-seller.js');
}

export function ensureAntiAfkEnabled() {
    window.postMessage({ type: 'COR3_ANTI_AFK_TOGGLE', enabled: true }, '*');
}

// Auto-start solvers if they were enabled before page load
chrome.storage.sync.get(['autoDecryptEnabled', 'autoIceWallEnabled', 'autoSimpleDecryptEnabled'], (data) => {
    if (data.autoDecryptEnabled) {
        injectDecryptSolver();
    }
    if (data.autoIceWallEnabled) {
        injectIceWallSolver();
    }
    if (data.autoSimpleDecryptEnabled) {
        injectSimpleDecryptSolver();
    }
});
