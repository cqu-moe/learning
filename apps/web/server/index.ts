import { createWebServer, resolveDefaultDataDir } from './app.ts';

const portArg = process.argv.find(arg => arg.startsWith('--port='));
const portFlagIndex = process.argv.indexOf('--port');
const portValue = portArg?.slice('--port='.length) ?? (portFlagIndex === -1 ? undefined : process.argv[portFlagIndex + 1]);
const port = Number(portValue ?? process.env.LEARNING_WEB_PORT ?? 4311);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('--port must be an integer from 1 through 65535');
}

const explicitOrigins = process.env.LEARNING_WEB_ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(value => value !== '') ?? [];
const allowVite = process.env.LEARNING_WEB_ALLOW_VITE === '1';
const allowedOrigins = [...explicitOrigins, ...(allowVite ? ['http://127.0.0.1:5174'] : [])];
const server = createWebServer({
  dataDir: resolveDefaultDataDir(),
  port,
  allowedOrigins,
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Learning web API listening on http://127.0.0.1:${port}`);
});

const shutdown = () => server.close(error => {
  process.exitCode = error === undefined ? 0 : 1;
});
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
