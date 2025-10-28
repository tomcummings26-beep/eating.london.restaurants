# Eating London Enricher

A minimal Node.js worker that enriches Airtable restaurant records with Google Places data and optional AI copywriting. Designed for deployment on [Railway](https://railway.app/) with scheduled runs.

## Features

- Idempotent upsert flow keyed by `Slug`
- Google Places Text Search + Details + Photos hydration
- Optional OpenAI-powered description blurb generation
- Rate limiting to protect Google and Airtable quotas
- Configurable concurrency and batch limits via environment variables

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

   Optional tuning variables are documented inline in `.env.example`.

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
     | Lat | Number |
     | Lng | Number |
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
     | Last Enriched | Date |
     | Enrichment Status | Single select (`pending` / `enriched` / `not_found` / `error`) |
     | Notes | Long text |

   - Seed the table with at least `Name`, `Slug`, and optionally `API Source` / `API ID`. The included [`airtable_restaurants_seed.csv`](./airtable_restaurants_seed.csv) provides a header with all fields and a sample row to import into Airtable.

4. **Run locally**

   ```bash
   npm run start
   ```

   The worker will process up to `MAX_RECORDS_PER_RUN` entries marked as `pending` (or missing Place ID / Photo / Description).

5. **Deploy on Railway**

   - Create a new Railway project and connect this repository.
   - Store your secrets in Railway so they are available at runtime:
     - In the dashboard, open **Variables** and add every key/value from your local `.env` file.
     - Or use the CLI: `railway variables set AIRTABLE_API_KEY=...` (repeat for each variable).
     - Verify they are available with `railway variables` or `railway run node -e "console.log(process.env.AIRTABLE_API_KEY)"`.
   - Railway automatically exposes these variables to the Node.js process—no `.env` file is needed in production, and the worker reads `process.env` directly.
   - Deploy (Railway will run `npm install` followed by `npm start`).
   - Configure a schedule (e.g., hourly) under **Cron / Schedules** with the command `npm run start`.
   - For manual backfills, trigger `npm run once` from the Railway run tab.

## Notes

- Google Places API usage incurs cost—tune the schedule, batch size, and rate limits to match your quota.
- When Google supplies a photo attribution, ensure it is displayed alongside the image on your site to comply with the license.
- The worker is idempotent: repeated runs update the same record via the slug.
- If `OPENAI_API_KEY` is omitted, descriptions remain untouched or blank.
