const rawMode = (process.env.START_MODE || process.env.RUN_MODE || '').trim().toLowerCase();

const mode = rawMode || 'server';

const isWorkerMode = ['worker', 'workers', 'job', 'queue', 'cron', 'enrich', 'enricher'].includes(mode);
const isServerMode = ['server', 'serve', 'web', 'api'].includes(mode);

if (isWorkerMode) {
  await import('./index.js');
} else if (isServerMode || mode === 'server') {
  await import('./server.js');
} else if (!rawMode) {
  await import('./server.js');
} else {
  console.warn(`Unknown START_MODE "${rawMode}" – defaulting to server.`);
  await import('./server.js');
}
