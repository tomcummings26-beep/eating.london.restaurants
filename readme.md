# Eating London Enricher

A minimal Node.js worker that enriches Airtable restaurant records with Google Places data and optional AI copywriting. Designed for deployment on [Railway](https://railway.app/) with scheduled runs.

## Features

- Idempotent upsert flow keyed by `Slug`
- Google Places Text Search + Details + Photos hydration
- Optional OpenAI-powered description blurb generation
- Automatic Instagram profile discovery from restaurant websites
- Rate limiting to protect Google and Airtable quotas
- Configurable concurrency and batch limits via environment variables
- JSON feed endpoint (`/restaurants`) for Framer or other consumers

## Getting Started

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   Copy `.env.example` to `.env` and supply your keys:

   ```bash
   cp .env.example .env
   ```

   Required keys:

   - `AIRTABLE_API_KEY`
   - `AIRTABLE_BASE_ID`
   - `GOOGLE_PLACES_API_KEY`

   Optional tuning variables are documented inline in `.env.example` (including overrides for the `Enrichment Status` select options if your Airtable column uses different labels).

3. **Prepare Airtable**

   - Create a base (default name `eating.london`) and a table (default `Restaurants`).
   - Add the following fields (type suggestions in parentheses):

     | Field | Type |
     | --- | --- |
     | Name | Single line text |
     | Slug | Single line text (unique) |
     | API Source | Single select (`SevenRooms` / `Tock` / `OpenTable` / `Resy`) |
     | API ID | Text |
     | Place ID | Text |
     | Address | Long text |
     | City | Text |
     | Postcode | Text |
     | Lat | Number (8 decimal places) |
     | Lng | Number (8 decimal places) |
     | Website | URL |
     | Phone | Text |
     | Cuisine | Text |
     | Price Level | Number (0–4) |
     | Rating | Number |
     | User Ratings | Number |
     | Opening Hours JSON | Long text |
     | Photo URL | URL |
     | Photo Attribution | Long text |
     | Description | Long text |
     | Instagram | URL |
     | Instagram Status | Single select (`pending` / `found` / `not_found` / `error` / `retry`) |
     | Last Enriched | Date |
     | Enrichment Status | Single select (`pending` / `enriched` / `not_found` / `error`) |
     | Notes | Long text |

   - Seed the table with at least `Name`, `Slug`, and optionally `API Source` / `API ID`. The included [`airtable_restaurants_seed.csv`](./airtable_restaurants_seed.csv) provides a header with all fields and a sample row to import into Airtable.

   > ℹ️ Airtable currently caps numeric precision at eight decimal places. The worker rounds latitude and longitude to that precision before saving to keep uploads compatible with the field settings above.

4. **Run locally**

  - **Worker:**

    ```bash
    npm start
    ```

   The worker will process up to `MAX_RECORDS_PER_RUN` entries whose **Enrichment Status** (case-insensitive) is `pending`, `error`, `enriched`, or blank *and*
    are still missing a Place ID, photo, description, or Instagram profile. Rows whose **Instagram Status** is `not_found` or `error` are skipped so the worker doesn’t loop forever on websites that block crawlers. To retry one of those rows, clear the Instagram link and set **Instagram Status** to `retry` (or blank) before running the worker again. Records marked as `not_found` in the main enrichment status are ignored; everything else with missing
    data is eligible, so you no longer need to toggle a row back to `pending` just to fill in a new Instagram link. The script continues automatically until no matching
    records remain. If you want to stop after a single batch—for example,
     while testing rate limits—run the `once` script instead:

     ```bash
     npm run once             # equivalent to `node index.js --once`
     ```

     To explicitly loop forever (useful if you set a very small `MAX_RECORDS_PER_RUN`), you can still run the backfill helper:

     ```bash
     npm run backfill         # equivalent to `node index.js --all`
     ```

     You can also override the batch size at runtime without editing `.env`:

     ```bash
     node index.js --max=100   # process up to 100 records in this invocation
     ```

  - **Instagram backfill (optional):**

    ```bash
    npm run instagram
    ```

    Walks the entire table, fetches each restaurant website, and looks for a canonical Instagram profile link (regardless of `Enrichment Status`). Rows whose Instagram links are blank *and* whose **Instagram Status** is not `not_found`/`error` are updated by default—pass `--force` (via `npm run instagram:force`) to re-check every row even
    if it already contains a value. The script honours `INSTAGRAM_CONCURRENCY` and `INSTAGRAM_REQUEST_INTERVAL_MS` to control
    crawl pacing.

    When the crawler can’t find a profile—or the target site blocks the request—it records `not_found` or `error` in **Instagram Status** so future runs don’t keep retrying the same website. Reset the status to `retry` to queue it back up after you’ve fixed a website URL or want to take another shot manually.

  - **JSON feed server:**

     ```bash
     npm run serve
     # or
     START_MODE=server npm start
     ```

     This launches an Express server that exposes `GET /restaurants`, returning a cached JSON payload of the Airtable table. The server honours
     `RESTAURANTS_CACHE_TTL_MS` (defaults to five minutes) to avoid hammering Airtable on every request.

5. **Deploy on Railway**

   - Create a new Railway project and connect this repository.
   - Store your secrets in Railway so they are available at runtime:
     - In the dashboard, open **Variables** and add every key/value from your local `.env` file.
     - Or use the CLI: `railway variables set AIRTABLE_API_KEY=...` (repeat for each variable).
     - Verify they are available with `railway variables` or `railway run node -e "console.log(process.env.AIRTABLE_API_KEY)"`.
   - Railway automatically exposes these variables to the Node.js process—no `.env` file is needed in production. The worker detects when it is running on Railway and logs that it is using Railway Variables via `process.env`.
   - Deploy (Railway will run `npm install` followed by `npm start`; by default this executes the worker. Set `START_MODE=server` in Railway Variables or change the start command to `npm run serve` if you want the JSON feed service to be the primary process).
   - Configure a schedule (e.g., hourly) under **Cron / Schedules** with the command `npm start` or `npm run worker` (both run the worker).
   - For manual backfills, trigger `npm run backfill` from the Railway run tab to walk through every pending record in batches of
     `MAX_RECORDS_PER_RUN`.

## JSON feed

The Express server mounted by `npm start` exposes the following endpoints:

- `GET /` – lightweight status payload listing available routes.
- `GET /restaurants` – returns `{ generatedAt, count, restaurants }` where `restaurants` is an array of normalised restaurant records.

The handler caches Airtable responses in-memory for `RESTAURANTS_CACHE_TTL_MS` milliseconds (default: `300000`, i.e. 5 minutes). Append
`?refresh=true` to bypass the cache on-demand. Responses include permissive CORS headers so Framer or other frontend environments can fetch
the JSON directly from Railway, and each restaurant entry exposes the Instagram profile URL when available.

## Staying in sync with `main`

When a pull request reports merge conflicts, update your feature branch before pushing more commits:

```bash
# from the repository root while on your feature branch
./scripts/update_from_main.sh
```

The helper script fetches the latest `origin/main`, updates your local `main` branch, then lets you choose between rebasing or merging those changes into the current branch. Resolving any conflicts locally keeps the PR conflict-free on GitHub.

## Notes

- Google Places API usage incurs cost—tune the schedule, batch size, and rate limits to match your quota.
- When Google supplies a photo attribution, ensure it is displayed alongside the image on your site to comply with the license.
- The worker is idempotent: repeated runs update the same record via the slug.
- If `OPENAI_API_KEY` is omitted, descriptions remain untouched or blank.

## Troubleshooting

- **Airtable `NOT_FOUND` (404)** – Confirm that `AIRTABLE_BASE_ID` and `AIRTABLE_TABLE_NAME` match the base/table names exactly (Airtable is case-sensitive) and that the API key has access to the base. After renaming a table, redeploy or restart the worker so it picks up the correct value.
- **Airtable `INVALID_MULTIPLE_CHOICE_OPTIONS`** – Ensure the `Enrichment Status` single-select column contains every status the worker can write (`pending`, `enriched`, `not_found`, `error` by default). If you prefer different casing or labels, set `AIRTABLE_ENRICHMENT_STATUS_OPTIONS` to a comma-separated list of the exact options configured in Airtable.
