import dotenv from 'dotenv';
import Airtable from 'airtable';
import express from 'express';
import cors from 'cors';

import createRestaurantsRouter from './routes/restaurants.js';

const isRailway = Boolean(
  process.env.RAILWAY_STATIC_URL ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_ENVIRONMENT
);

if (!isRailway) {
  const { error } = dotenv.config();
  if (error && error.code !== 'ENOENT') {
    console.error('Failed to load local .env file:', error);
  }
} else {
  console.log('[config] Railway environment detected – expecting secrets via Railway Variables.');
}

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME = 'Restaurants',
  RESTAURANTS_CACHE_TTL_MS = '300000',
  PORT = process.env.PORT || 3000
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('Missing Airtable configuration. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID.');
  process.exit(1);
}

const cacheTtlMs = Number.parseInt(RESTAURANTS_CACHE_TTL_MS, 10);
const ttlMs = Number.isFinite(cacheTtlMs) && cacheTtlMs > 0 ? cacheTtlMs : 300000;

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const table = base(AIRTABLE_TABLE_NAME);

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: '*', maxAge: Math.floor(ttlMs / 1000) }));

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    endpoints: ['/restaurants'],
    cacheTtlMs: ttlMs
  });
});

app.use('/restaurants', createRestaurantsRouter({ table, cacheTtlMs: ttlMs }));

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const httpServer = app.listen(PORT, () => {
  console.log(`Restaurant feed available on port ${PORT}`);
});

const shutdown = (signal) => {
  console.log(`Received ${signal}. Shutting down restaurant feed server…`);
  httpServer.close((err) => {
    if (err) {
      console.error('Error during server shutdown:', err);
      process.exit(1);
    }
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
