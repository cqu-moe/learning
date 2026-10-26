import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const { build: bunBuild } = globalThis.Bun;
const [entry, outfile, tokenDefine] = process.argv.slice(2);
const sources = {
  '@learning/sdk': 'packages/sdk/src/index.ts',
  '@learning/sdk/public': 'packages/sdk/src/public.ts',
  '@learning/sdk/node': 'packages/sdk/src/runtime/node/index.ts',
  '@learning/sdk/render-node': 'packages/sdk/src/runtime/node/render.ts',
};
const sdkTypescriptSources = {
  name: 'learning-sdk-typescript-sources',
  setup(build) {
    build.onResolve({ filter: /^@learning\/sdk(?:\/.*)?$/ }, args => {
      const source = sources[args.path];
      if (source === undefined) throw new Error(`unsupported Learning SDK import: ${args.path}`);
      return { path: resolve(root, source), namespace: 'file' };
    });
  },
};

const output = await bunBuild({
  entrypoints: [entry],
  compile: { outfile, autoloadDotenv: false, autoloadBunfig: false },
  target: 'bun',
  format: 'esm',
  minify: { whitespace: true },
  bytecode: true,
  sourcemap: 'external',
  env: 'disable',
  ...(tokenDefine === undefined ? {} : { define: { 'process.env.LEARNING_BUNDLED_TELEMETRY_TOKEN': tokenDefine } }),
  plugins: [sdkTypescriptSources],
});
if (!output.success) throw new AggregateError(output.logs, 'Bun build failed');
