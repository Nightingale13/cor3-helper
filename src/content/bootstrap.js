import { bootstrapContent } from '../shared/content-bootstrap.js';

bootstrapContent(() => import('./index.js').then(module => module.contentReady))
    .catch(error => console.error('[COR3 Helper] Content script failed to start:', error));
