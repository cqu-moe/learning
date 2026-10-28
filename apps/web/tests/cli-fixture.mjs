import '../../cli/tests/fixture-fetch.mjs';
import process from 'node:process';
import { URL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';

const replay = globalThis.fetch;
globalThis.fetch = async (request) => {
  const response = await replay(request);
  if (new URL(request.url).pathname !== process.env.LEARNING_INTEROP_PAUSE_PATH) return response;
  process.stderr.write('interop: segment waiting\n');
  await new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('interop segment was not canceled')), 20_000);
    const abort = () => { clearTimeout(timeout); reject(new globalThis.DOMException('Aborted', 'AbortError')); };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
  });
  return response;
};
