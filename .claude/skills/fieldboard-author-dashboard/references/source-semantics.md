# Governed source semantics

Always call `context` first. Treat its catalog of `project.schema.table` relations, schemas, active warehouse snapshot, row grain, cautions, and example rows as authoritative for the current invocation. The warehouse may change between installations or revisions.

DuckDB files are the grain store. Authoring SQL is DuckDB against registered `project.schema.table` relations from the live catalog. The bundled demo currently ships `fashion.catalog.products` and `tlc.taxi.yellow_trips`; treat those as examples, not the product domain. JOINs among registered triples are allowed. Summary tables written at publication time are not an authoring source. There is no `source_data` compatibility view.

## Establish meaning before analysis

- Identify which catalog relation answers the question and the business entity represented by one row. If context does not establish it, qualify conclusions as row-level observations.
- Identify candidate dimensions, measures, identifiers, timestamps, units, and status fields from the returned schema and evidence—not from prior dashboards.
- Check missingness and cardinality before choosing aggregations.
- Use distinct counts only when the identifier and business interpretation are supported.
- Never compare values across currencies, units, populations, or time grains without an explicit compatible basis.
- Distinguish point-in-time snapshots from event histories and time series.

Ask a focused exploratory question through the governed query endpoint when a column's interpretation is uncertain. Put unresolved semantic uncertainty in the dashboard caveats. Exploration queries return ephemeral JSON and do not materialize a summary table.

## SQL rules

Write one DuckDB `SELECT` or `WITH` statement over registered `project.schema.table` relations and local CTEs. JOINs among listed triples are allowed. Do not include SQL comments or semicolons. Do not use `source_data`, an unlisted table, URL, file/table function (`file()`, `read_*`, `s3`), system catalog, DDL, DML, pragma, attach, install, load, copy, export, or mutable operation.

Do not query `summaries/` prefixes or call `read_parquet`. Do not invent object-store paths. Fieldboard materializes accepted dataset SQL as partitioned summary Parquet during publication and hydrates those files with DuckDB at dashboard GET time.

Keep output chart-ready and bounded:

- Alias every derived column with a valid lowercase identifier.
- Apply explicit null filters and deterministic ordering.
- Limit high-cardinality rankings.
- Return only columns used by the widget, tooltip, or analytical explanation.
- Set `expectedColumns` to the required output names and `maxRows` to the meaningful display limit, never above 500.

Test every final SQL sidecar through the governed `query` command before publication.

Provenance warehouse identity is a catalog revision id and date. It is not a summary object prefix.
