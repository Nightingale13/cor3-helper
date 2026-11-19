import { bootstrapContent } from '../shared/content-bootstrap.js';
import { loadAsAutomationOwner } from '../shared/automation-owner.js';

bootstrapContent(() => loadAsAutomationOwner(() => import('./index.js').then(module => module.contentReady)))
    .catch(error => console.error('[COR3 Helper] Content script failed to start:', error));
