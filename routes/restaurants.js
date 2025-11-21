import express from 'express';

const DEFAULT_TTL = 300000;

/* ------------------------- Helpers ------------------------- */

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
    } catch (_err) {
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
    instagram: fields['Instagram'] || '',
    phone: fields['Phone'] || '',
    cuisine: fields['Cuisine'] || '',
    priceLevel: numericOrNull(fields['Price Level']),
    rating: numericOrNull(fields['Rating']),
    userRatings: numericOrNull(fields['User Ratings']),
    openingHours: parseOpeningHours(fields['Opening Hours JSON']),
    photoUrl: fields['Photo URL'] || '',
    photoAttribution: fields['Photo Attribution'] || '',
    description: fields['Description'] || '',
    lastEnriched: fields['Last Enriched'] || null,
    enrichmentStatus: fields['Enrichment Status'] || null,
    notes: fields['Notes'] || ''
  };
};

/* ------------------------- Router Factory ------------------------- */

const createRestaurantsRouter = ({ table, cacheTtlMs = DEFAULT_TTL }) => {
  if (!table) {
    throw new Error('createRestaurantsRouter requires a configured Airtable table instance.');
  }

  const ttl = Number.isFinite(cacheTtlMs) && cacheTtlMs > 0 ? cacheTtlMs : DEFAULT_TTL;

  let cache = {
    data: null,
    fetchedAt: 0
  };

  const fetchRestaurants = async (forceRefresh = false) => {
    const now = Date.now();
    if (!forceRefresh && cache.data && now - cache.fetchedAt < ttl) {
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

  const router = express.Router();

  /* ------------------------- GET /restaurants (full list OR ?slug=) ------------------------- */
  router.get('/', async (req, res) => {
    try {
      const force = req.query.refresh === 'true';
      const slug = req.query.slug?.toLowerCase();

      const { data, fetchedAt, cached } = await fetchRestaurants(force);

      // If query param ?slug=... is passed → return single item
      if (slug) {
        const match = data.find((r) => r.slug?.toLowerCase() === slug);

        if (!match) {
          return res.status(404).json({
            error: 'restaurant_not_found',
            message: `No restaurant found for slug: ${slug}`
          });
        }

        res.set('Cache-Control', `public, max-age=${Math.floor(ttl / 1000)}`);
        res.set('X-Data-Fresh', cached ? 'cache' : 'live');

        return res.json(match);
      }

      // Otherwise return full list
      res.set('Cache-Control', `public, max-age=${Math.floor(ttl / 1000)}`);
      res.set('X-Data-Fresh', cached ? 'cache' : 'live');

      return res.json({
        generatedAt: new Date(fetchedAt).toISOString(),
        count: data.length,
        restaurants: data
      });

    } catch (error) {
      console.error('Failed to load restaurants from Airtable:', error);
      return res.status(500).json({
        error: 'failed_to_load_restaurants',
        message: 'Unable to load restaurants from Airtable.'
      });
    }
  });

  /* ------------------------- 🆕 GET /restaurants/:slug ------------------------- */
  router.get('/:slug', async (req, res) => {
    try {
      const slugParam = req.params.slug?.toLowerCase();

      if (!slugParam) {
        return res.status(400).json({
          error: 'invalid_slug',
          message: 'Slug is required'
        });
      }

      const { data, fetchedAt, cached } = await fetchRestaurants(false);
      const match = data.find((r) => r.slug?.toLowerCase() === slugParam);

      if (!match) {
        return res.status(404).json({
          error: 'restaurant_not_found',
          message: `No restaurant found for slug: ${slugParam}`
        });
      }

      res.set('Cache-Control', `public, max-age=${Math.floor(ttl / 1000)}`);
      res.set('X-Data-Fresh', cached ? 'cache' : 'live');

      return res.json(match);

    } catch (error) {
      console.error('Failed to load restaurant by slug:', error);
      return res.status(500).json({
        error: 'failed_to_load_restaurant',
        message: 'Unable to load restaurant by slug.'
      });
    }
  });

  return router;
};

export default createRestaurantsRouter;

