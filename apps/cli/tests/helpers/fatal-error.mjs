import { setImmediate } from 'node:timers';

await import('../../dist/index.js');
setImmediate(() => { throw new Error('fatal fixture failure', { cause: new TypeError('fixture transport failed') }); });
