import dotenv from 'dotenv';
import Airtable from 'airtable';
import Bottleneck from 'bottleneck';

import {
  findInstagramProfile,
  addInstagramSkipNote,
  hasInstagramSkipNote,
  removeInstagramSkipNote,
  INSTAGRAM_SKIP_SENTINEL
} from '../lib/instagram.js';

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
  CONCURRENCY = '2',
  SLEEP_MS_BETWEEN_REQUESTS = '250'
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('Missing Airtable configuration. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID.');
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const maxArg = args.find((arg) => arg.startsWith('--max='));
const maxRecords = maxArg ? Number.parseInt(maxArg.split('=')[1], 10) : null;

const limiter = new Bottleneck({
  maxConcurrent: Number(CONCURRENCY) || 2,
  minTime: Number(SLEEP_MS_BETWEEN_REQUESTS) || 250
});

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const table = base(AIRTABLE_TABLE_NAME);

const clean = (value) => (value == null ? '' : String(value).trim());

const shouldSkip = (record) => {
  if (!record?.fields) return true;
  const website = clean(record.fields['Website']);
  if (!website) return true;
  if (!force && clean(record.fields['Instagram'])) return true;
  if (!force && hasInstagramSkipNote(record.fields['Notes'])) return true;
  return false;
};

const normalizeNotes = (value) => {
  if (!value) return '';
  return String(value).trim();
};

const ensureNewlineSeparated = (value) => {
  if (!value) return '';
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
};

const updateRecord = async (recordId, fields) => {
  await table.update([{ id: recordId, fields }]);
};

async function run() {
  console.log('Loading Airtable records…');
  const query = table.select({
    sort: [{ field: 'Name', direction: 'asc' }],
    maxRecords: Number.isFinite(maxRecords) && maxRecords > 0 ? maxRecords : undefined
  });

  const records = await query.all();
  const targets = records.filter((record) => !shouldSkip(record));

  if (!targets.length) {
    console.log('Nothing to enrich. ✅');
    return;
  }

  console.log(`Found ${targets.length} record(s) needing Instagram URLs…`);

  let successes = 0;
  let failures = 0;

  for (const record of targets) {
    const fields = record.fields || {};
    const name = clean(fields['Name']) || record.id;
    const website = clean(fields['Website']);
    const existingInstagram = clean(fields['Instagram']);
    const existingNotes = normalizeNotes(fields['Notes']);

    if (!website) {
      continue;
    }

    if (!force && existingInstagram) {
      continue;
    }

    if (!force && hasInstagramSkipNote(existingNotes)) {
      continue;
    }

    try {
      const result = await findInstagramProfile(website, { limiter });

      if (result?.url) {
        successes += 1;
        const updates = {
          Instagram: result.url
        };

        const cleanedNotes = removeInstagramSkipNote(existingNotes);
        if (cleanedNotes !== existingNotes && !dryRun) {
          updates['Notes'] = ensureNewlineSeparated(cleanedNotes);
        }

        if (dryRun) {
          console.log(`🔍 [dry-run] ${name} → ${result.url}`);
        } else {
          await updateRecord(record.id, updates);
          console.log(`✅ Found Instagram for ${name}: ${result.url}`);
        }
        continue;
      }

      failures += 1;
      const reason = result?.message || 'No profile discovered.';
      console.log(`⚠️  ${name}: ${reason}`);

      if (!dryRun) {
        const updatedNotes = addInstagramSkipNote(existingNotes, reason);
        if (updatedNotes !== existingNotes) {
          await updateRecord(record.id, {
            Notes: ensureNewlineSeparated(updatedNotes)
          });
        }
      }
    } catch (error) {
      failures += 1;
      const message = error?.message || 'Unknown error';
      console.log(`❌ ${name}: ${message}`);
      if (!dryRun) {
        const updatedNotes = addInstagramSkipNote(existingNotes, message);
        if (updatedNotes !== existingNotes) {
          await updateRecord(record.id, {
            Notes: ensureNewlineSeparated(updatedNotes)
          });
        }
      }
    }

    await limiter.schedule(() => Promise.resolve());
  }

  console.log('Done. ✅');
  console.log(`Instagram URLs added: ${successes}`);
  console.log(`Unable to resolve: ${failures}`);

  if (!dryRun && failures > 0) {
    console.log(
      `Rows marked with ${INSTAGRAM_SKIP_SENTINEL} in Notes will be skipped in future runs. Remove the tag to retry.`
    );
  }
}

run().catch((error) => {
  console.error('Fatal:', error?.response?.data || error);
  process.exit(1);
});

