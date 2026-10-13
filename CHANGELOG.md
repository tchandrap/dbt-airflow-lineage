# Changelog

## 0.1.0 — first public release

- Interactive lineage graph from `target/manifest.json` (drag, pan, zoom, animated links for the selected node).
- Built-in dbt selector engine: names, `tag:`, `path:`, `source:`, `package:`, `config.*`, `+` / `N+` / `@`, union, intersection, `--exclude`, named selectors from `selectors.yml`.
- Floating selector search, filter popover (select / exclude / types), find-in-graph, legend.
- Optional Airflow pipelines: which DAG runs a model (dbt selectors) and which DAG ingests a table (BigQuery dataset + table in DAG code).
- Airflow source setup wizard: local folder or Google Cloud Storage (bucket browser, access test, sign-in recovery).
- Model details dialog that edits the model's YAML in place: description, tags, config, meta, tests, columns.
