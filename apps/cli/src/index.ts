#!/usr/bin/env node
// Minimal local CLI entry for T01: the workspace/build pipeline is this task's
// deliverable. The full command set is assembled in T25/T26 on top of @learning/sdk.
import pkg from '../package.json' with { type: 'json' };

const [firstArg] = process.argv.slice(2);
if (firstArg === '--version' || firstArg === '-v') {
  process.stdout.write(`learning ${pkg.version} (SDK+CLI phase; commands land in T25)\n`);
  process.exit(0);
}
process.stderr.write('learning: no commands yet (T25); try --version\n');
process.exit(2);
