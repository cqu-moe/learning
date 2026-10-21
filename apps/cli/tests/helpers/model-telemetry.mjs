import assert from 'node:assert/strict';
import { createOutput, bindOutput } from '../../dist/output.js';
import { createProgram } from '../../dist/program.js';
import { withCliRuntime, selectProfile } from '../../dist/context.js';
import { startTelemetry, finishTelemetry } from '../../dist/telemetry.js';

const nativeFetch = globalThis.fetch;
let modelCalls = 0;
globalThis.fetch = async (input, options) => {
  const request = new Request(input, options);
  if (request.url === 'https://model.example.test/SECRET_ENDPOINT/chat/completions') {
    modelCalls++;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('authorization'), 'Bearer SECRET_MODEL_KEY');
    assert.equal(request.headers.get('content-type'), 'application/json');
    const body = await request.json();
    assert.equal(body.model, 'fixture-model');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages[1], { role: 'user', content: JSON.stringify({ text: 'SECRET_PROMPT' }) });
    return Response.json({ choices: [{ message: { content: process.env.FIXTURE_INVALID_MODEL_OUTPUT === '1' ? 'SECRET_BAD_JSON' : '{"text":"SECRET_REPLY"}' } }], usage: { prompt_tokens: 12, completion_tokens: 7 } });
  }
  const target = new URL(request.url);
  assert.equal(target.origin, new URL(process.env.LEARNING_TELEMETRY_HOST).origin, 'undeclared external request');
  assert.equal(target.hostname, '127.0.0.1');
  return nativeFetch(request);
};

const output = createOutput({ format: 'json', interactive: false, quiet: true, color: false, debug: false });
const program = createProgram();
program.setOptionValue('home', process.env.LEARNING_HOME);
program.setOptionValue('profile', 'SECRET_ALPHA');
bindOutput(program, output);
await startTelemetry(output, process.env.LEARNING_HOME, 'discuss draft');
let error;
try {
  await withCliRuntime(program, false, async runtime => {
    await selectProfile(program, runtime);
    const result = await runtime.model.propose({ purpose: 'discussion', content: { text: 'SECRET_PROMPT' }, signal: output.signal });
    assert.deepEqual(result, { text: 'SECRET_REPLY' });
  });
} catch (caught) {
  error = caught;
} finally {
  await output.finish(error);
  await finishTelemetry(output, error);
  output.close();
}
assert.equal(modelCalls, 1);
