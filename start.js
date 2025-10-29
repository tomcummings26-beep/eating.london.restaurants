const mode = (process.env.START_MODE || process.env.RUN_MODE || '').toLowerCase();

if (mode === 'server' || mode === 'serve' || mode === 'web') {
  await import('./server.js');
} else {
  await import('./index.js');
}
