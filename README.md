# Fieldboard

Fieldboard is a local proof of concept for prompt-generated, source-backed analytical dashboards. Prose and layout live in Markdown, `dashboard` fences place validated widgets, ECharts handles standard charts, and bounded D3 runs in a network-disabled iframe.

The product is source-agnostic. DuckDB files are the warehouse grain (`project.schema.table`). DuckDB also runs authoring SQL, writes summary Parquet to MinIO, and hydrates those files when a dashboard is fetched. Authored dashboards are canonical Git bundles. Application PostgreSQL stores the relation registry, validated projections, publication state, events, and summary pointers—not summary row payloads.

## Workspace layout

All Fieldboard-owned repositories live inside this checkout:

```text
auto_dashboard_poc/
  apps/                              Vue and Hono applications
  packages/contracts/                shared artifact and API contracts
  fieldboard_content/                canonical dashboard Git repository
  .claude/skills/
    fieldboard-author-dashboard/      in-tree authoring skill
```

`fieldboard_content/` is ignored by the parent repository and keeps its own Git history. The authoring skill is ordinary files in this checkout.

## Stack

- Vue 3 + Vite, ECharts, D3, Marked, and DOMPurify
- Hono on Node 22
- PostgreSQL 17 application control plane
- DuckDB Node Neo grain catalogs, plus DuckDB summary writes and reads
- MinIO Hive-partitioned summary Parquet
- Local Git-canonical Markdown, SQL, JSON, and bounded JavaScript bundles
- One stateless Cline SDK agent through OpenRouter in live mode

## Start locally

Prerequisites are Docker with Compose, Node 22+, and npm. Copy environment defaults once; `make setup` will not overwrite a filled `.env`.

```sh
cp .env.example .env
make purge
make setup
```

`make purge` stops Compose, deletes named volumes, warehouse files, cached downloads, and `fieldboard_content/`. It does not delete `.env`. `make setup` installs dependencies, bootstraps an empty Git content repository, downloads the public Hugging Face fashion catalog and TLC Q1 2026 Parquet, loads `data/warehouse/*.duckdb` on the host, then starts the stack and waits until warehouse, MinIO, and the content repository are ready with a populated catalog.

`make down` stops containers without deleting data. Reload grain with `make data-load-fashion-catalog` and `make data-load-tlc-yellow`, then `make data-init`.

- App: <http://localhost:5173>
- API health: <http://localhost:3000/api/health>
- MinIO console: <http://localhost:9001>
- Application PostgreSQL: `localhost:5432`
- Warehouse files: `./data/warehouse`
- Canonical content: `./fieldboard_content`

`GET /api/health` reports warehouse, MinIO, repository readiness, and registered relations.

The default `AGENT_MODE=demo` is deterministic and spends no LLM credits. Its example counts rows in each registered catalog relation.

The easiest way to author a real dashboard is Claude Code with the in-tree skill. You do not need OpenRouter or `AGENT_MODE=cline` for that path.

## Configure warehouse relations

Grain lives in per-project DuckDB files. The bundled demo currently uses:

```text
data/warehouse/
  fashion.duckdb    # fashion.catalog.products
  tlc.duckdb        # tlc.taxi.yellow_trips
```

Those two relations are examples you can replace. `WAREHOUSE_DIR` defaults to `./data/warehouse`. Application PostgreSQL registers triples in `warehouse_relations`. After a loader writes rows, increment happens automatically and API startup fingerprints the catalog as `warehouse:catalog@<snapshot-id>`.

`fashion.duckdb` loads from the public Hugging Face [`nreimers/fashion-dataset`](https://huggingface.co/datasets/nreimers/fashion-dataset) CSV (cached at `data/raw/fashion-train.csv`). TLC loads official monthly Parquet for 2026 Q1. There is no `source_data` table.

Accepted dataset results use paths shaped like:

```text
s3://analytics/summaries/dashboard=<uuid>/dataset=<id>/revision=<uuid>/version=<uuid>/as_of=<date>/*.parquet
```

Agents receive the catalog of governed triples, registered grain/cautions, bounded examples, and snapshot provenance from `GET /api/authoring/context`. They query only listed `project.schema.table` relations; PostgreSQL credentials, MinIO paths, filesystem tools, and arbitrary tables are unavailable.

## Author dashboards with Claude Code

After `make setup`, open this checkout in Claude Code. The skill is already at `.claude/skills/fieldboard-author-dashboard`, so Claude Code can load it from the project. Keep the stack running, then ask for one dashboard in plain language:

```text
/fieldboard-author-dashboard

Build a dashboard from fashion.catalog.products covering category volume and gender mix.
Use DuckDB SQL against registered warehouse relations only.
```

Claude Code queries the live catalog, writes `dashboard.md`, SQL, and chart sidecars into `fieldboard_content/`, validates the bundle, and publishes it through Fieldboard. Open the returned URL on <http://localhost:5173>. Revise the same dashboard by naming it and describing the change.

The skill discovers the active warehouse at runtime. It must not assume a product catalog or reuse semantics from an earlier snapshot. It never runs Git commands, repairs repository state, accesses PostgreSQL directly, or uses an arbitrary storage path.

To use the same skill outside this checkout:

```sh
cp -R .claude/skills/fieldboard-author-dashboard ~/.claude/skills/fieldboard-author-dashboard
cp -R .claude/skills/fieldboard-author-dashboard ~/.codex/skills/fieldboard-author-dashboard
```

Fieldboard never performs remote Git operations.

The opt-in smoke test creates and publishes a real, schema-independent fixture dashboard:

```sh
RUN_FIELDBOARD_SKILL_SMOKE=1 node --test .claude/skills/fieldboard-author-dashboard/tests/live-smoke.test.mjs
```

## Use Cline with OpenRouter

```dotenv
AGENT_MODE=cline
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=anthropic/claude-sonnet-4.6
AGENT_MAX_COST_USD=1
AGENT_RUN_TIMEOUT_MS=900000
QUERY_TIMEOUT_MS=120000
```

The stateless Cline agent receives exactly three auto-approved tools: `get_source_context`, `run_readonly_query`, and `submit_dashboard`. Filesystem, shell, editor, web, PostgreSQL, Git, and arbitrary storage tools are absent. Final submission materializes each dataset as summary Parquet. TLC aggregations need `QUERY_TIMEOUT_MS=120000`; a full Cline run against that grain needs `AGENT_RUN_TIMEOUT_MS=900000`.

## Git-canonical content

Each dashboard keeps a stable UUID-backed directory:

```text
dashboards/revenue-operations--ccf25439/
  fieldboard.json
  dashboard.md
  provenance.json
  queries/revenue-by-region.sql
  widgets/revenue-by-region.echarts.json
```

Git `main` is canonical; PostgreSQL is the control-plane projection. Every revision is pinned to a commit and artifact hash. External edits are reviewed at <http://localhost:5173/repository>, fingerprinted, security-validated, and rerun against the warehouse before import. Fieldboard never fetches, pulls, pushes, resets, stashes, merges, or rewrites history.

Analytics SQL is restricted to one DuckDB `SELECT`/`WITH` statement over registered `project.schema.table` relations and local CTEs. JOINs among those triples are allowed. Mutations, DDL, pragmas, extensions, URLs, file functions, system catalogs, `source_data`, multiple statements, responses above 500 rows or 2 MB, and queries beyond `QUERY_TIMEOUT_MS` (maximum 120 seconds) are rejected. The bundled TLC grain needs that 120-second maximum for aggregations.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Live source reconciliation and OpenRouter checks remain opt-in:

```sh
RUN_DATA_INTEGRATION=1 npm run test -w @fieldboard/api
RUN_OPENROUTER_SMOKE=1 AGENT_MODE=cline OPENROUTER_API_KEY=... npm run test -w @fieldboard/api
```

## API

- `GET /api/authoring/context`
- `POST /api/authoring/queries`
- `POST /api/generations`
- `GET /api/generations/:id` and `/events`
- `GET /api/dashboards` and `GET /api/dashboards/:id`
- dashboard refinement, restore, revision, and refresh routes
- `GET /api/repository` and `GET /api/repository/diff`
- repository validation/import and publication status/retry routes
- `GET /api/health`

This remains a local, single-user POC without authentication, sharing, scheduling, uploads, arbitrary SQL editing, client-side DuckDB, or production deployment support.
