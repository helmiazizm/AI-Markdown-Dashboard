import { z } from 'zod'

const booleanString = z.string().default('false').transform((value) => value.toLowerCase() === 'true')

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgresql://fieldboard:fieldboard@localhost:5432/fieldboard'),
  WAREHOUSE_DIR: z.string().default('./data/warehouse'),
  MINIO_ENDPOINT: z.string().default('localhost:9000'),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),
  MINIO_BUCKET: z.string().default('analytics'),
  MINIO_USE_SSL: booleanString,
  AGENT_MODE: z.enum(['demo', 'cline', 'crew']).default('crew'),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-sonnet-4.6'),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(30).default(12),
  AGENT_MAX_TOKENS_PER_TURN: z.coerce.number().int().min(1024).max(32_768).default(8192),
  AGENT_MAX_COST_USD: z.coerce.number().positive().default(1),
  AGENT_RUN_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(300_000),
  // Crew mode runs four roles, so it needs its own ceiling; an empty per-role model falls back
  // to OPENROUTER_MODEL. The reviewer is the role most worth pointing at a stronger model.
  CREW_MAX_COST_USD: z.coerce.number().positive().default(4),
  CREW_PLANNER_MODEL: z.string().default(''),
  CREW_ANALYSIS_MODEL: z.string().default(''),
  CREW_LAYOUT_MODEL: z.string().default(''),
  CREW_REVIEWER_MODEL: z.string().default(''),
  CREW_ANALYSIS_QUERY_BUDGET: z.coerce.number().int().min(1).max(60).default(20),
  CREW_REVIEW_QUERY_BUDGET: z.coerce.number().int().min(0).max(20).default(4),
  QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  QUERY_MAX_ROWS: z.coerce.number().int().min(1).max(500).default(500),
  QUERY_MAX_BYTES: z.coerce.number().int().min(64_000).max(8_388_608).default(2_097_152),
  DUCKDB_EXTENSION_DIRECTORY: z.string().default('.duckdb/extensions'),
  CONTENT_REPOSITORY_ENABLED: z.string().default('true').transform((value) => value.toLowerCase() === 'true'),
  CONTENT_REPOSITORY_PATH: z.string().default('./fieldboard_content'),
  CONTENT_GIT_BRANCH: z.string().regex(/^[A-Za-z0-9._\/-]+$/).default('main'),
  CONTENT_GIT_AUTHOR_NAME: z.string().min(1).max(120).default('Fieldboard'),
  CONTENT_GIT_AUTHOR_EMAIL: z.string().regex(/^[^\s@]+@[^\s@]+$/).default('fieldboard@local'),
  CONTENT_INDEX_INTERVAL_MS: z.coerce.number().int().min(250).max(600_000).default(3000),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
})

export type AppConfig = z.infer<typeof envSchema>

let cached: AppConfig | undefined

export function getConfig(): AppConfig {
  cached ??= envSchema.parse(process.env)
  return cached
}

export function resetConfigForTests(): void {
  cached = undefined
}
