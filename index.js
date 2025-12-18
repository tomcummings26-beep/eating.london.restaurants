import dotenv from 'dotenv';
import Airtable from 'airtable';
import axios from 'axios';
import Bottleneck from 'bottleneck';
import slugify from 'slugify';

// In production (Railway) configuration must come from environment variables.
// For local development we still allow a .env file.
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
  OPENAI_API_KEY,
  AIRTABLE_ENRICHMENT_STATUS_OPTIONS,
  REFRESH_PHOTOS
} = process.env;

const OPENAI_ENABLED = Boolean(OPENAI_API_KEY);

const cliArgs = process.argv.slice(2);
const maxOverrideArg = cliArgs.find((arg) => arg.startsWith('--max='));
const runOnceFlag = cliArgs.includes('--once');
const runAllFlag = cliArgs.includes('--all');
const runContinuously = runAllFlag || !runOnceFlag;
const refreshPhotosFlag = cliArgs.includes('--refresh-photos');
const refreshPhotos = refreshPhotosFlag || parseBoolean(REFRESH_PHOTOS);

const parseMaxRecords = () => {
  const defaultMax = Number(MAX_RECORDS_PER_RUN);
  const sanitizedDefault = Number.isFinite(defaultMax) && defaultMax > 0 ? defaultMax : 50;

  if (!maxOverrideArg) {
    return sanitizedDefault;
  }

  const parsed = Number.parseInt(maxOverrideArg.split('=')[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Ignored --max override "${maxOverrideArg}" because it is not a positive integer. Using ${sanitizedDefault}.`
    );
    return sanitizedDefault;
  }

  return parsed;
};

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !GOOGLE_PLACES_API_KEY) {
  console.error('Missing required env vars. Please set AIRTABLE_API_KEY, AIRTABLE_BASE_ID, GOOGLE_PLACES_API_KEY.');
  process.exit(1);
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const table = base(AIRTABLE_TABLE_NAME);

const isAirtableNotFound = (err) =>
  err?.statusCode === 404 && err?.error === 'NOT_FOUND';

const logAirtableNotFoundHelp = () => {
  console.error('Fatal: Airtable returned NOT_FOUND (404).');
  console.error(
    'Double-check AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, and that the AIRTABLE_API_KEY has access to the base and table.'
  );
  console.error(
    'If the table was recently created, ensure the name matches exactly (including casing) and that the base ID is correct.'
  );
};

// Rate limiters (be gentle to Google + Airtable)
const limiter = new Bottleneck({
  minTime: Number(SLEEP_MS_BETWEEN_REQUESTS),
  maxConcurrent: Number(CONCURRENCY)
});

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseSelectOptions = (value, fallback = []) => {
  if (!value) return [...fallback];
  const entries = value
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean);
  return entries.length ? entries : [...fallback];
};

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(normalized);
};

const enrichmentStatusOptions = parseSelectOptions(
  AIRTABLE_ENRICHMENT_STATUS_OPTIONS,
  ['pending', 'enriched', 'not_found', 'error']
);

let notesFieldAvailable = true;

const matchSelectOption = (desired, options, fieldName) => {
  if (!desired) return undefined;
  const normalized = desired.trim().toLowerCase();
  for (const option of options) {
    if (option.trim().toLowerCase() === normalized) {
      return option;
    }
  }
  console.warn(
    `[airtable] ${fieldName || 'Select field'} value "${desired}" is not configured. Valid options: ${options.join(', ')}`
  );
  return undefined;
};

const pickEnrichmentStatus = (status, fallback) => {
  const matched = matchSelectOption(status, enrichmentStatusOptions, 'Enrichment Status');
  if (matched !== undefined) return matched;
  if (fallback) {
    const fallbackMatched = matchSelectOption(
      fallback,
      enrichmentStatusOptions,
      'Enrichment Status'
    );
    if (fallbackMatched !== undefined) return fallbackMatched;
  }
  return undefined;
};

const currentTimestampForAirtable = () => new Date().toISOString();

const currentDateForAirtable = () => currentTimestampForAirtable().split('T')[0];

const resolveLastEnrichedValue = (existing) => {
  const hasExisting = existing !== undefined && existing !== null && existing !== '';
  if (!hasExisting) {
    return currentDateForAirtable();
  }

  if (existing instanceof Date) {
    return currentTimestampForAirtable();
  }

  if (typeof existing === 'string') {
    if (existing.includes('T')) {
      return currentTimestampForAirtable();
    }
    return currentDateForAirtable();
  }

  return currentDateForAirtable();
};

const toNumberOrNull = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const trimmed = String(value).trim();
  if (trimmed === '') return null;

  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const preferNumeric = (primary, fallback) => {
  const first = toNumberOrNull(primary);
  if (first !== null) return first;
  return toNumberOrNull(fallback);
};

const roundToPrecision = (value, precision) => {
  if (typeof precision !== 'number' || !Number.isFinite(precision)) return value;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

const coerceNumericField = (incoming, fallback, fieldName, options = {}) => {
  const coerced = preferNumeric(incoming, fallback);
  if (
    coerced === null &&
    [incoming, fallback].some((val) => {
      if (val === undefined || val === null) return false;
      if (typeof val === 'string' && val.trim() === '') return false;
      return true;
    })
  ) {
    console.warn(
      `[airtable] Could not parse numeric value for ${fieldName}. Primary="${incoming}" Fallback="${fallback}"`
    );
    return coerced;
  }

  if (coerced === null) {
    return coerced;
  }

  if (typeof options.precision === 'number') {
    return roundToPrecision(coerced, options.precision);
  }

  return coerced;
};

const toSlug = (name) =>
  slugify(name || '', { lower: true, strict: true, trim: true });

const clean = (s) => (s == null ? '' : String(s).trim());

const isMissingNotesFieldError = (error) =>
  notesFieldAvailable &&
  error?.statusCode === 422 &&
  typeof error?.message === 'string' &&
  error.message.toLowerCase().includes('notes');

const sanitizeOptionalFields = (fields) => {
  if (!notesFieldAvailable && Object.prototype.hasOwnProperty.call(fields, 'Notes')) {
    const clone = { ...fields };
    delete clone['Notes'];
    return clone;
  }
  return fields;
};

const performTableAction = async (action, records) => {
  if (!Array.isArray(records) || !records.length) return [];
  const prepared = records.map((entry) => ({
    ...entry,
    fields: sanitizeOptionalFields(entry.fields || {})
  }));

  try {
    return await table[action](prepared);
  } catch (error) {
    if (isMissingNotesFieldError(error)) {
      notesFieldAvailable = false;
      console.warn('[airtable] Notes field not found; retrying without Notes updates.');
      const retried = prepared.map((entry) => {
        if (!Object.prototype.hasOwnProperty.call(entry.fields, 'Notes')) {
          return entry;
        }
        const cloneFields = { ...entry.fields };
        delete cloneFields['Notes'];
        return { ...entry, fields: cloneFields };
      });
      if (!retried.length) return [];
      return await table[action](retried);
    }
    throw error;
  }
};

const upsertBySlug = async (slug, fields, recordId, options = {}) => {
  const { omitSlug = false } = options;
  const sanitizedSlug = clean(slug);
  let payload = { ...fields };
  if (!omitSlug && sanitizedSlug) {
    payload['Slug'] = sanitizedSlug;
  }

  if (recordId) {
    await performTableAction('update', [{ id: recordId, fields: payload }]);
    return recordId;
  }

  if (sanitizedSlug) {
    const query = `Slug = "${sanitizedSlug.replace(/"/g, '\\"')}"`;
    const found = await table
      .select({ filterByFormula: query, maxRecords: 1 })
      .firstPage();
    if (found.length) {
      const id = found[0].id;
      await performTableAction('update', [{ id, fields: payload }]);
      return id;
    }
  }

  const created = await performTableAction('create', [{ fields: payload }]);
  return created[0]?.id;
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
const hashString = (value) => {
  if (!value) return 0;
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0; // force 32-bit integer
  }
  return Math.abs(hash);
};

const descriptionPromptTemplates = [
  ({ name, cuisine, area }) => `Craft a 65-90 word featurette for a London restaurant profile.
Lead with a vivid sensory scene from ${area || 'London'} that does not begin with the words "Discover" or "Experience".
Highlight what sets ${name} apart, referencing its ${cuisine || 'signature'} influences or standout dishes.
Finish with an inviting line that hints at the vibe without repeating earlier phrases.
Avoid cliches and keep the tone energetic yet polished.`,
  ({ name, cuisine, area }) => `Write a tight 65-90 word editorial blurb about ${name} in ${area || 'London'}.
Open with a compelling statement about the ambience or hospitality—no generic "Discover" openers.
Weave in a specific detail about the ${cuisine || 'house'} menu or a service ritual.
Close with a call to action that feels bespoke to this venue.
Keep the language modern, no emojis, and do not repeat the restaurant name more than once.`,
  ({ name, cuisine, area }) => `Produce a 65-90 word mini-review for a dining guide.
Start with a line that evokes the atmosphere of ${name} without using the phrases "Discover", "Experience", or "culinary gem".
Describe one memorable element of its ${cuisine || 'kitchen'} or beverage program and mention ${area || 'London'} context once.
End with a forward-looking note that invites return visits in your own words.
Maintain an upbeat, sophisticated tone with varied sentence structure.`,
];

const selectDescriptionPrompt = (info) => {
  const key = `${info.slug || ''}:${info.name || ''}`;
  const index = hashString(key) % descriptionPromptTemplates.length;
  return descriptionPromptTemplates[index](info);
};

async function generateDescription({ name, cuisine, area, slug }) {
  if (!OPENAI_API_KEY) return ''; // optional
  const prompt = selectDescriptionPrompt({ name, cuisine, area, slug });
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

  const enrichedStatusValue = pickEnrichmentStatus('enriched');
  const isAlreadyEnriched =
    enrichedStatusValue &&
    typeof fields['Enrichment Status'] === 'string' &&
    fields['Enrichment Status'].trim().toLowerCase() === enrichedStatusValue.trim().toLowerCase();

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
        if (isAlreadyEnriched) {
          console.log(`Skipping photo refresh for ${name} (no Place ID found)`);
          return;
        }

        const status = pickEnrichmentStatus('not_found');
        const update = {
          'Last Enriched': resolveLastEnrichedValue(fields['Last Enriched'])
        };
        if (status) update['Enrichment Status'] = status;
        await upsertBySlug(slug, update, record.id);
        console.log(`Not found: ${name}`);
        return;
      }
    }

    // Step 2: Details
    const details = await getPlaceDetails(placeId);
    if (!details) {
      if (isAlreadyEnriched) {
        console.log(`Skipping photo refresh for ${name} (no details returned)`);
        return;
      }

      const status = pickEnrichmentStatus('error', 'pending');
      const update = {
        'Place ID': placeId,
        Notes: 'No details returned from Places',
        'Last Enriched': resolveLastEnrichedValue(fields['Last Enriched'])
      };
      if (status) update['Enrichment Status'] = status;
      await upsertBySlug(slug, update, record.id);
      console.log(`No details: ${name}`);
      return;
    }

    const { postcode, city } = extractAddressBits(details.address_components);
    const enrichedStatusValue = pickEnrichmentStatus('enriched');
    const isAlreadyEnriched =
      enrichedStatusValue &&
      typeof fields['Enrichment Status'] === 'string' &&
      fields['Enrichment Status'].trim().toLowerCase() === enrichedStatusValue.trim().toLowerCase();
    const firstPhoto = details.photos?.[0];
    const photoUrl = firstPhoto ? buildPhotoUrl(firstPhoto.photo_reference) : '';
    const photoAttr = firstPhoto ? buildPhotoAttribution(firstPhoto) : '';
    const areaGuess = city || DEFAULT_CITY;

    const lat = coerceNumericField(
      details.geometry?.location?.lat,
      fields['Lat'],
      'Lat',
      { precision: 8 }
    );
    const lng = coerceNumericField(
      details.geometry?.location?.lng,
      fields['Lng'],
      'Lng',
      { precision: 8 }
    );
    const priceLevel = coerceNumericField(details.price_level, fields['Price Level'], 'Price Level');
    const ratingValue = coerceNumericField(details.rating, fields['Rating'], 'Rating');
    const userRatings = coerceNumericField(
      details.user_ratings_total,
      fields['User Ratings'],
      'User Ratings'
    );

    // Cuisine: Google returns types; take a human-friendly first type if available
    const cuisine =
      (details.types || [])
        .filter((t) => !['point_of_interest', 'establishment', 'food', 'restaurant'].includes(t))
        .map((t) => t.replace(/_/g, ' '))
        [0] || (fields['Cuisine'] || '');

    // Optional description (only if empty)
    let description = clean(fields['Description']);
    if (!description) {
      description = await generateDescription({
        name: details.name,
        cuisine,
        area: areaGuess,
        slug,
      });
    }

    // Step 3: Upsert
    if (isAlreadyEnriched) {
      await upsertBySlug(
        slug,
        {
          'Photo URL': photoUrl || fields['Photo URL'] || ''
        },
        record.id,
        { omitSlug: true }
      );
      console.log(`Updated photo only: ${name} (${slug})`);
      return;
    }

    const payload = {
      'Name': details.name || name,
      'Slug': slug,
      'Place ID': placeId,
      'Address': details.formatted_address || fields['Address'] || '',
      'City': city || fields['City'] || '',
      'Postcode': postcode || fields['Postcode'] || '',
      'Lat': lat,
      'Lng': lng,
      'Website': details.website || fields['Website'] || '',
      'Phone': details.formatted_phone_number || details.international_phone_number || fields['Phone'] || '',
      'Cuisine': cuisine,
      'Price Level': priceLevel,
      'Rating': ratingValue,
      'User Ratings': userRatings,
      'Opening Hours JSON': JSON.stringify(details.opening_hours?.weekday_text || []),
      'Photo URL': photoUrl || fields['Photo URL'] || '',
      'Photo Attribution': photoAttr || fields['Photo Attribution'] || '',
      'Description': description || fields['Description'] || '',
      'Last Enriched': resolveLastEnrichedValue(fields['Last Enriched'])
    };

    if (enrichedStatusValue) payload['Enrichment Status'] = enrichedStatusValue;

    await upsertBySlug(slug, payload, record.id);
    console.log(`Enriched: ${name} (${slug})`);
  } catch (err) {
    if (isAirtableNotFound(err)) {
      throw err;
    }

    if (isAlreadyEnriched) {
      console.error(`Error refreshing photo for ${name}:`, err?.response?.data || err.message);
      return;
    }

    console.error(`Error enriching ${name}:`, err?.response?.data || err.message);
    const status = pickEnrichmentStatus('error', 'pending');
    const fallbackFields = {
      'Notes': String(err?.message || err),
      'Last Enriched': resolveLastEnrichedValue(fields['Last Enriched'])
    };
    if (status) fallbackFields['Enrichment Status'] = status;
    await upsertBySlug(slug, fallbackFields, record.id);
  }
}

const statusesToReprocess = ['pending', 'error', 'enriched'];

const buildStatusFilterFormula = (statuses) => {
  const predicates = statuses.map(
    (status) => `LOWER({Enrichment Status}) = '${status.toLowerCase()}'`
  );
  predicates.push("{Enrichment Status} = ''");
  predicates.push('{Enrichment Status} = BLANK()');
  return `OR(\n      ${predicates.join(',\n      ')}\n    )`;
};

async function fetchPendingBatch(limit) {
  const statusFilter = buildStatusFilterFormula(statusesToReprocess);
  const descriptionNeedsWork = OPENAI_ENABLED
    ? `OR({Description} = BLANK(), {Description} = '')`
    : null;

  const recheckPredicates = ['{Place ID} = BLANK()', '{Photo URL} = BLANK()'];

  if (refreshPhotos) {
    recheckPredicates.push('TRUE()');
  }

  if (descriptionNeedsWork) {
    recheckPredicates.push(descriptionNeedsWork);
  }
  if (!recheckPredicates.length) {
    recheckPredicates.push('TRUE()');
  }

  const filter = `AND(
    ${statusFilter},
    OR(
      ${recheckPredicates.join(',\n      ')}
    )
  )`;

  const collected = [];

  try {
    await table
      .select({ filterByFormula: filter, maxRecords: limit })
      .eachPage((records, fetchNext) => {
        collected.push(...records);
        fetchNext();
      });
  } catch (err) {
    const missingNotesField =
      notesFieldAvailable &&
      err?.statusCode === 422 &&
      err?.error === 'INVALID_FILTER_BY_FORMULA' &&
      typeof err?.message === 'string' &&
      err.message.toLowerCase().includes('notes');

    if (missingNotesField) {
      notesFieldAvailable = false;
      console.warn('[airtable] Notes field not found; retrying without Notes filter conditions.');
      return fetchPendingBatch(limit);
    }

    throw err;
  }

  return collected;
}

async function run() {
  const maxPerBatch = parseMaxRecords();
  let totalProcessed = 0;
  let iteration = 0;

  if (refreshPhotos) {
    console.log('[photos] Refresh mode enabled – reprocessing records even if photos are present.');
  }

  while (true) {
    const toProcess = await fetchPendingBatch(maxPerBatch);

    if (!toProcess.length) {
      if (iteration === 0) {
        console.log('Nothing to enrich. ✅');
      } else {
        console.log('No more records to enrich. ✅');
      }
      break;
    }

    iteration += 1;
    console.log(`Found ${toProcess.length} record(s) to enrich…`);

    for (const rec of toProcess) {
      await enrichRecord(rec);
      totalProcessed += 1;
      await sleep(Number(SLEEP_MS_BETWEEN_REQUESTS));
    }

    if (!runContinuously) {
      break;
    }
  }

  if (totalProcessed > 0) {
    console.log(`Done. ✅ Processed ${totalProcessed} record(s).`);
  }
}

run().catch((e) => {
  if (isAirtableNotFound(e)) {
    logAirtableNotFoundHelp();
  } else {
    console.error('Fatal:', e?.response?.data || e);
  }
  process.exit(1);
});
