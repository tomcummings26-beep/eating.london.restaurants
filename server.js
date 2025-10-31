// server.js
import dotenv from 'dotenv';
import Airtable from 'airtable';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import createRestaurantsRouter from './routes/restaurants.js';
import rankingsRouter from './routes/rankings.js';
import runEnrichment from './enrich.js'; // 👈 your Airtable→Google→restaurants.json script

// ---------- Environment detection ----------
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

// ---------- Env Vars ----------
const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME = 'Restaurants',
  RESTAURANTS_CACHE_TTL_MS = '300000',
  PORT = process.env.PORT || 3000,
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('❌ Missing Airtable configuration. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID.');
  process.exit(1);
}

const cacheTtlMs = Number.parseInt(RESTAURANTS_CACHE_TTL_MS, 10);
const ttlMs = Number.isFinite(cacheTtlMs) && cacheTtlMs > 0 ? cacheTtlMs : 300000;

// ---------- Airtable setup ----------
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const table = base(AIRTABLE_TABLE_NAME);

// ---------- Express setup ----------
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: '*', maxAge: Math.floor(ttlMs / 1000) }));

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const restaurantsPath = path.join(__dirname, 'restaurants.json');

// ---------- Wait until restaurants.json exists ----------
async function waitForRestaurantsJson(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(restaurantsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(restaurantsPath, 'utf8'));
        if (data && Array.isArray(data) && data.length > 0) {
          console.log('✅ restaurants.json found and ready');
          return true;
        }
      } catch {
        // keep waiting if JSON invalid
      }
    }
    console.log('⏳ Waiting for restaurants.json to be ready...');
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('❌ restaurants.json not ready within timeout');
}

// ---------- Start server after enrichment ----------
async function startServer() {
  try {
    console.log('🚀 Starting enrichment phase...');
    await runEnrichment(); // generate restaurants.json
    console.log('✅ Enrichment complete');

    await waitForRestaurantsJson();

    // ---------- Root route ----------
    app.get('/', (_req, res) => {
      res.json({
        status: 'ok',
        endpoints: ['/restaurants', '/rankings'],
        cacheTtlMs: ttlMs,
      });
    });

    // ---------- Routes ----------
    app.use('/restaurants', createRestaurantsRouter({ table, cacheTtlMs: ttlMs }));
    app.use('/rankings', rankingsRouter);

    // ---------- 404 handler ----------
    app.use((req, res) => {
      res.status(404).json({ error: 'not_found' });
    });

    // ---------- Server startup ----------
    const httpServer = app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`Available endpoints: /restaurants  |  /rankings`);
    });

    // ---------- Graceful shutdown ----------
    const shutdown = (signal) => {
      console.log(`🛑 Received ${signal}. Shutting down gracefully...`);
      httpServer.close((err) => {
        if (err) {
          console.error('Error during shutdown:', err);
          process.exit(1);
        }
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
}

startServer();


