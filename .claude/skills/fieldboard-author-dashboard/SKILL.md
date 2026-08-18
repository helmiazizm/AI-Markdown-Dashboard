---
name: fieldboard-author-dashboard
description: Create or revise Git-canonical Fieldboard dashboards from natural-language analytical requests. Use when an analyst wants to author dashboard Markdown for governed warehouse relations (project.schema.table), add or change read-only DuckDB SQL datasets, build ECharts or bounded D3 widgets, validate an external dashboard bundle, or publish the result through Fieldboard without directly using Git, warehouse credentials, or object storage.
---

# Fieldboard Dashboard Authoring

Turn one analyst request into one evidence-backed dashboard bundle. Keep the analyst experience conversational while coordinating the Markdown, manifest, queries, and widget sidecars required by Fieldboard.

## Start safely

1. Treat the directory containing this `SKILL.md` as the skill root. Claude Code exposes it as `${CLAUDE_SKILL_DIR}`.
2. Run `node "${CLAUDE_SKILL_DIR}/scripts/fieldboard-author.mjs" doctor` before editing anything. Its `limits` block reports the field bounds validation enforces; keep every authored field inside them rather than trusting a length copied from prose.
3. Stop without modifying files when the doctor reports a dirty, unavailable, or detached repository. If the repository is unindexed, wait for the content indexer to catch up rather than editing or importing.
4. Read [references/bundle-contract.md](references/bundle-contract.md) and [references/source-semantics.md](references/source-semantics.md). Read [references/chart-authoring.md](references/chart-authoring.md) before changing a widget.
5. Work on exactly one dashboard directory per invocation. Never reset, clean, stash, switch branches, commit, push, pull, fetch, or repair Git.

## Gather evidence

1. Run the helper's `context` command before writing SQL.
2. Treat the returned catalog of `project.schema.table` relations, schemas, grain, cautions, example rows, and warehouse snapshot as authoritative. Do not infer a business domain from earlier runs.
3. Use only the helper's `query --input <json-file>` command to inspect the warehouse. Put temporary request files outside the content repository. Exploration results are ephemeral JSON and do not create a summary table.
4. Keep exploration focused and bounded. Reuse a final tested query as the dataset sidecar instead of inventing a second version.
5. State the source grain, filters, null handling, units, denominators, and time boundary wherever they affect interpretation.

## Create or revise

For a new dashboard, run `draft-metadata --title <title> --note <note>` and use its IDs, stable content path, warehouse snapshot, and provisional provenance verbatim. Create the complete bundle only after the analytical queries and widget design are ready.

For a revision, load the entire existing bundle first. Preserve its directory, `dashboardId`, and `provenance.json`. Update `dashboard.md`, `fieldboard.json`, and only the required sidecars. Remove obsolete sidecars because unknown files invalidate the bundle. Never rename or delete the dashboard directory.

Write an answer-first analytical document:

- Lead with the decision-relevant result, then show evidence and caveats.
- Use ordinary Markdown for prose, headings, lists, and compact tables.
- Place each widget exactly once with the deterministic `dashboard` fence.
- Prefer ECharts. Use D3 only when custom geometry or interaction materially improves the analysis.
- Keep result rows out of authored files. Fieldboard materializes each final dataset as partitioned summary Parquet in object storage and injects those rows at render time.
- Make the title, summary, questions, SQL columns, widget descriptions, and accessibility text agree.

## Validate and publish

1. Review every changed file and confirm all changes belong to the single target dashboard.
2. Run `validate-import --dashboard <content-path> --note <5-240 character note>`.
3. Let the helper fingerprint the repository, run Fieldboard validation, rerun every final warehouse query, persist summary tables, and automatically import only a successful unchanged fingerprint.
4. If validation fails, correct the reported bundle or query issue and run the command again. Do not weaken or bypass validation.
5. If the fingerprint changes or publication blocks, stop. Report the changed files and direct the analyst to `/repository`; never perform Git repair.
6. On success, report the dashboard URL, revision, publication ID, and commit SHA returned by the helper.
