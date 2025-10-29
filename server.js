import dotenv from 'dotenv';
import Airtable from 'airtable';
import express from 'express';
import cors from 'cors';

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

const numericOrNull = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const parseOpeningHours = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  return [];
};

const toRestaurant = (record) => {
  const fields = record.fields || {};
  return {
    id: record.id,
    name: fields['Name'] || '',
    slug: fields['Slug'] || '',
    apiSource: fields['API Source'] || null,
    apiId: fields['API ID'] || null,
    placeId: fields['Place ID'] || null,
    address: fields['Address'] || '',
    city: fields['City'] || '',
    postcode: fields['Postcode'] || '',
    lat: numericOrNull(fields['Lat']),
    lng: numericOrNull(fields['Lng']),
    website: fields['Website'] || '',
    phone: fields['Phone'] || '',
    cuisine: fields['Cuisine'] || '',
    priceLevel: numericOrNull(fields['Price Level']),
    rating: numericOrNull(fields['Rating']),
    userRatings: numericOrNull(fields['User Ratings']),
    instagram: fields['Instagram'] || '',
    openingHours: parseOpeningHours(fields['Opening Hours JSON']),
    photoUrl: fields['Photo URL'] || '',
    photoAttribution: fields['Photo Attribution'] || '',
    description: fields['Description'] || '',
    lastEnriched: fields['Last Enriched'] || null,
    enrichmentStatus: fields['Enrichment Status'] || null,
    notes: fields['Notes'] || ''
  };
};

let cache = {
  data: null,
  fetchedAt: 0
};

const fetchRestaurants = async (forceRefresh = false) => {
  const now = Date.now();
  if (!forceRefresh && cache.data && now - cache.fetchedAt < ttlMs) {
    return { data: cache.data, fetchedAt: cache.fetchedAt, cached: true };
  }

  const records = await table
    .select({
      sort: [{ field: 'Name', direction: 'asc' }]
    })
    .all();

  const data = records.map(toRestaurant);
  cache = { data, fetchedAt: Date.now() };
  return { data, fetchedAt: cache.fetchedAt, cached: false };
};

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    endpoints: ['/restaurants'],
    cacheTtlMs: ttlMs
  });
});

app.get('/restaurants', async (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    const { data, fetchedAt, cached } = await fetchRestaurants(force);
    res.set('Cache-Control', `public, max-age=${Math.floor(ttlMs / 1000)}`);
    res.set('X-Data-Fresh', cached ? 'cache' : 'live');
    res.json({
      generatedAt: new Date(fetchedAt).toISOString(),
      count: data.length,
      restaurants: data
    });
  } catch (error) {
    console.error('Failed to load restaurants from Airtable:', error);
    res.status(500).json({
      error: 'failed_to_load_restaurants',
      message: 'Unable to load restaurants from Airtable.'
    });
  }
});

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
