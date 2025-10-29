import dotenv from 'dotenv';
import Airtable from 'airtable';
import Bottleneck from 'bottleneck';
import { findInstagramProfile, normalizeInstagramProfileUrl } from '../lib/instagram.js';

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
  INSTAGRAM_CONCURRENCY = '1',
  INSTAGRAM_REQUEST_INTERVAL_MS = '500',
  AIRTABLE_INSTAGRAM_STATUS_OPTIONS
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('Missing Airtable configuration. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID.');
  process.exit(1);
}

const parseSelectOptions = (value, fallback = []) => {
  if (!value) return [...fallback];
  const entries = value
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean);
  return entries.length ? entries : [...fallback];
};

const matchSelectOption = (desired, options) => {
  if (!desired) return undefined;
  const normalized = desired.trim().toLowerCase();
  for (const option of options) {
    if (option.trim().toLowerCase() === normalized) {
      return option;
    }
  }
  return undefined;
};

const pickInstagramStatus = (status, fallback, options, logger = console) => {
  const matched = matchSelectOption(status, options);
  if (matched !== undefined) return matched;
  if (fallback) {
    const fallbackMatched = matchSelectOption(fallback, options);
    if (fallbackMatched !== undefined) return fallbackMatched;
  }
  if (status) {
    logger?.warn?.(
      `[instagram] Unable to apply Instagram Status "${status}". Valid options: ${options.join(', ')}`
    );
  }
  return undefined;
};

const instagramStatusOptions = parseSelectOptions(
  AIRTABLE_INSTAGRAM_STATUS_OPTIONS,
  ['pending', 'found', 'not_found', 'error', 'retry']
);

const forceRecheck = process.argv.includes('--force');

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const table = base(AIRTABLE_TABLE_NAME);

const limiter = new Bottleneck({
  minTime: Number(INSTAGRAM_REQUEST_INTERVAL_MS) || 500,
  maxConcurrent: Number(INSTAGRAM_CONCURRENCY) || 1
});

const schedule = (task) => limiter.schedule(task);

const flushUpdates = async (updates, logger) => {
  if (!updates.length) return 0;
  const batch = updates.splice(0, 10);
  try {
    await schedule(() => table.update(batch));
    logger?.log?.(`[instagram] Updated ${batch.length} record(s).`);
    return batch.length;
  } catch (error) {
    logger?.error?.(
      `[instagram] Failed to update ${batch.length} record(s): ${error?.message || error}`
    );
    return 0;
  }
};

async function run() {
  const instagramCache = new Map();
  const records = await table.select().all();
  console.log(`[instagram] Inspecting ${records.length} record(s) for missing profiles…`);

  const updates = [];
  let updatedCount = 0;
  let examined = 0;
  let skipped = 0;

  for (const record of records) {
    examined += 1;
    const fields = record.fields || {};
    const name = fields['Name'] || record.id;
    const website = fields['Website'] || '';
    const existingStatusRaw = (fields['Instagram Status'] || '').trim();

    const existingInstagramRaw = (fields['Instagram'] || '').trim();
    const existingInstagram = normalizeInstagramProfileUrl(existingInstagramRaw);
    if (existingInstagram && !forceRecheck) {
      const desiredStatus = pickInstagramStatus('found', existingStatusRaw, instagramStatusOptions);
      const patchFields = {};
      if (existingInstagram !== existingInstagramRaw) {
        patchFields['Instagram'] = existingInstagram;
        console.log(`[instagram] Normalised ${name}: ${existingInstagram}`);
      }
      if (desiredStatus && desiredStatus !== existingStatusRaw) {
        patchFields['Instagram Status'] = desiredStatus;
      }
      if (Object.keys(patchFields).length) {
        updates.push({ id: record.id, fields: patchFields });
        if (updates.length >= 10) {
          updatedCount += await flushUpdates(updates, console);
        }
      }
      skipped += 1;
      continue;
    }

    if (!website) {
      const desiredStatus = pickInstagramStatus('not_found', existingStatusRaw, instagramStatusOptions);
      if (desiredStatus && desiredStatus !== existingStatusRaw) {
        updates.push({ id: record.id, fields: { 'Instagram Status': desiredStatus } });
        if (updates.length >= 10) {
          updatedCount += await flushUpdates(updates, console);
        }
      }
      skipped += 1;
      continue;
    }

    const cached = instagramCache.get(website);
    let instagramUrl = cached?.url ?? '';
    let lookupStatus = cached?.status ?? '';
    let lookupReason = cached?.reason ?? '';

    if (!instagramUrl || forceRecheck) {
      const lookup = await findInstagramProfile(website, {
        scheduler: schedule,
        logger: console
      });
      instagramUrl = lookup.url;
      lookupStatus = lookup.status;
      lookupReason = lookup.reason || '';
      instagramCache.set(website, lookup);
    }

    if (!instagramUrl) {
      const desiredStatus = pickInstagramStatus(
        lookupStatus === 'error' ? 'error' : 'not_found',
        existingStatusRaw,
        instagramStatusOptions
      );
      if (desiredStatus && desiredStatus !== existingStatusRaw) {
        updates.push({ id: record.id, fields: { 'Instagram Status': desiredStatus } });
        if (updates.length >= 10) {
          updatedCount += await flushUpdates(updates, console);
        }
      }
      if (lookupStatus === 'error' && lookupReason) {
        console.log(`[instagram] ${name}: status error (${lookupReason})`);
      }
      continue;
    }

    updates.push({
      id: record.id,
      fields: {
        Instagram: instagramUrl,
        'Instagram Status': pickInstagramStatus('found', existingStatusRaw, instagramStatusOptions)
      }
    });

    if (!fields['Instagram'] || forceRecheck) {
      console.log(`[instagram] ${name}: ${instagramUrl}`);
    }

    if (updates.length >= 10) {
      updatedCount += await flushUpdates(updates, console);
    }
  }

  updatedCount += await flushUpdates(updates, console);

  console.log(
    `[instagram] Complete. Examined ${examined} record(s); updated ${updatedCount}; skipped ${skipped}.`
  );
}

run().catch((error) => {
  console.error('[instagram] Fatal error:', error?.response?.data || error);
  process.exit(1);
});
