import 'dotenv/config';
import Airtable from 'airtable';
import axios from 'axios';
import Bottleneck from 'bottleneck';
import slugify from 'slugify';

// ---------- Config ----------
const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME = 'Restaurants',
  GOOGLE_PLACES_API_KEY,
  DEFAULT_CITY = 'London',
  DEFAULT_COUNTRY = 'UK',
  MAX_RECORDS_PER_RUN = '50',
  CONCURRENCY = '2',
  SLEEP_MS_BETWEEN_REQUESTS = '250',
  OPENAI_API_KEY
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !GOOGLE_PLACES_API_KEY) {
  console.error('Missing required env vars. Please set AIRTABLE_API_KEY, AIRTABLE_BASE_ID, GOOGLE_PLACES_API_KEY.');
  process.exit(1);
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const table = base(AIRTABLE_TABLE_NAME);

// Rate limiters (be gentle to Google + Airtable)
const limiter = new Bottleneck({
  minTime: Number(SLEEP_MS_BETWEEN_REQUESTS),
  maxConcurrent: Number(CONCURRENCY)
});

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toSlug = (name) =>
  slugify(name || '', { lower: true, strict: true, trim: true });

const clean = (s) => (s == null ? '' : String(s).trim());

const upsertBySlug = async (slug, fields) => {
  // Find existing
  const query = `Slug = "${slug.replace(/"/g, '\\"')}"`;
  const found = await table
    .select({ filterByFormula: query, maxRecords: 1 })
    .firstPage();
  if (found.length) {
    const id = found[0].id;
    await table.update([{ id, fields }]);
    return id;
  }
  const created = await table.create([{ fields: { Slug: slug, ...fields } }]);
  return created[0].id;
};

// ---------- Google Places ----------
async function findPlaceIdByText(name, city = DEFAULT_CITY, country = DEFAULT_COUNTRY) {
  const query = `${name}, ${city}, ${country}`.trim();
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
  const params = {
    query,
    key: GOOGLE_PLACES_API_KEY,
    region: 'gb'
  };
  const { data } = await limiter.schedule(() => axios.get(url, { params }));
  if (data.status !== 'OK' || !data.results?.length) return null;
  return data.results[0].place_id;
}

async function getPlaceDetails(placeId) {
  const url = 'https://maps.googleapis.com/maps/api/place/details/json';
  const fields = [
    'name',
    'formatted_address',
    'geometry/location',
    'website',
    'formatted_phone_number',
    'international_phone_number',
    'opening_hours/weekday_text',
    'type',
    'types',
    'price_level',
    'rating',
    'user_ratings_total',
    'address_components',
    'photos'
  ].join(',');
  const params = { place_id: placeId, fields, key: GOOGLE_PLACES_API_KEY, region: 'gb' };
  const { data } = await limiter.schedule(() => axios.get(url, { params }));
  if (data.status !== 'OK' || !data.result) return null;
  return data.result;
}

function extractAddressBits(components = []) {
  const get = (type) => components.find((c) => c.types.includes(type))?.long_name || '';
  return {
    postcode: get('postal_code'),
    city: get('postal_town') || get('locality') || '',
  };
}

function buildPhotoUrl(photoRef, maxWidth = 1200) {
  if (!photoRef) return '';
  const url = 'https://maps.googleapis.com/maps/api/place/photo';
  const params = new URLSearchParams({
    maxwidth: String(maxWidth),
    photoreference: photoRef,
    key: GOOGLE_PLACES_API_KEY
  });
  return `${url}?${params.toString()}`;
}

function buildPhotoAttribution(photoObj) {
  // Google requires attribution if provided
  if (!photoObj || !photoObj.html_attributions?.length) return '';
  return photoObj.html_attributions.join(' ');
}

// ---------- Optional AI copy ----------
async function generateDescription({ name, cuisine, area }) {
  if (!OPENAI_API_KEY) return ''; // optional
  const prompt = `Write a tight 60–90 word editorial blurb for a London restaurant landing page.\nName: ${name}\nCuisine: ${cuisine || 'Restaurant'}\nArea: ${area || 'London'}\nTone: energetic but classy, no fluff, no emojis. Avoid repeating the name more than once.`;
  try {
    const { data } = await limiter.schedule(() =>
      axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.6
        },
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
      )
    );
    return clean(data?.choices?.[0]?.message?.content || '');
  } catch (e) {
    console.warn('OpenAI description failed:', e?.response?.data || e.message);
    return '';
  }
}

// ---------- Main enrichment ----------
async function enrichRecord(record) {
  const fields = record.fields || {};
  const name = clean(fields['Name']);
  let slug = clean(fields['Slug']);
  if (!slug) slug = toSlug(name);

  if (!name) {
    console.log(`Skipping record ${record.id} (missing Name)`);
    return;
  }

  try {
    // Step 1: Find or reuse Place ID
    let placeId = clean(fields['Place ID']);
    if (!placeId) {
      placeId = await findPlaceIdByText(name);
      if (!placeId) {
        await upsertBySlug(slug, {
          'Enrichment Status': 'not_found',
          'Last Enriched': new Date().toISOString()
        });
        console.log(`Not found: ${name}`);
        return;
      }
    }

    // Step 2: Details
    const details = await getPlaceDetails(placeId);
    if (!details) {
      await upsertBySlug(slug, {
        'Place ID': placeId,
        'Enrichment Status': 'error',
        Notes: 'No details returned from Places',
        'Last Enriched': new Date().toISOString()
      });
      console.log(`No details: ${name}`);
      return;
    }

    const { postcode, city } = extractAddressBits(details.address_components);
    const firstPhoto = details.photos?.[0];
    const photoUrl = firstPhoto ? buildPhotoUrl(firstPhoto.photo_reference) : '';
    const photoAttr = firstPhoto ? buildPhotoAttribution(firstPhoto) : '';
    const areaGuess = city || DEFAULT_CITY;

    // Cuisine: Google returns types; take a human-friendly first type if available
    const cuisine =
      (details.types || [])
        .filter((t) => !['point_of_interest', 'establishment', 'food', 'restaurant'].includes(t))
        .map((t) => t.replace(/_/g, ' '))
        [0] || (fields['Cuisine'] || '');

    // Optional description (only if empty)
    let description = clean(fields['Description']);
    if (!description) {
      description = await generateDescription({ name: details.name, cuisine, area: areaGuess });
    }

    // Step 3: Upsert
    const payload = {
      'Name': details.name || name,
      'Slug': slug,
      'Place ID': placeId,
      'Address': details.formatted_address || fields['Address'] || '',
      'City': city || fields['City'] || '',
      'Postcode': postcode || fields['Postcode'] || '',
      'Lat': details.geometry?.location?.lat ?? null,
      'Lng': details.geometry?.location?.lng ?? null,
      'Website': details.website || fields['Website'] || '',
      'Phone': details.formatted_phone_number || details.international_phone_number || fields['Phone'] || '',
      'Cuisine': cuisine,
      'Price Level': details.price_level ?? fields['Price Level'] ?? null,
      'Rating': details.rating ?? fields['Rating'] ?? null,
      'User Ratings': details.user_ratings_total ?? fields['User Ratings'] ?? null,
      'Opening Hours JSON': JSON.stringify(details.opening_hours?.weekday_text || []),
      'Photo URL': photoUrl || fields['Photo URL'] || '',
      'Photo Attribution': photoAttr || fields['Photo Attribution'] || '',
      'Description': description || fields['Description'] || '',
      'Enrichment Status': 'enriched',
      'Last Enriched': new Date().toISOString()
    };

    await upsertBySlug(slug, payload);
    console.log(`Enriched: ${name} (${slug})`);
  } catch (err) {
    console.error(`Error enriching ${name}:`, err?.response?.data || err.message);
    await upsertBySlug(toSlug(fields['Slug'] || fields['Name'] || ''), {
      'Enrichment Status': 'error',
      'Notes': String(err?.message || err),
      'Last Enriched': new Date().toISOString()
    });
  }
}

async function run() {
  const max = Number(MAX_RECORDS_PER_RUN);

  // Fetch targets: pending or missing Place ID / Photo / Description
  const filter = `OR(
    {Enrichment Status} = 'pending',
    {Enrichment Status} = '',
    {Enrichment Status} = BLANK(),
    {Place ID} = BLANK(),
    {Photo URL} = BLANK(),
    {Description} = BLANK()
  )`;

  const toProcess = [];
  await table
    .select({ filterByFormula: filter, maxRecords: max })
    .eachPage((records, fetchNext) => {
      toProcess.push(...records);
      fetchNext();
    });

  if (!toProcess.length) {
    console.log('Nothing to enrich. ✅');
    return;
  }

  console.log(`Found ${toProcess.length} record(s) to enrich…`);

  // Process sequentially but rate-limited (simpler for quotas)
  for (const rec of toProcess) {
    await enrichRecord(rec);
    await sleep(Number(SLEEP_MS_BETWEEN_REQUESTS));
  }

  console.log('Done. ✅');
}

run().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
