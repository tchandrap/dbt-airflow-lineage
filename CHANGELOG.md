# Changelog

## Unreleased

- Renamed the display name to **dbt airflow lineage** (lowercase). The extension ID `tchandrap.dbt-airflow-lineage` is unchanged, so updates keep working. The activity bar, bottom panel and output channel use the same name.
- New icon: the lineage graph with the dbt and Airflow logos as small badges.

## 0.1.1 — 2026-10-13

- No longer marked as a preview: the Marketplace "Preview" badge is gone.
- README: animated demo of the extension in action (`docs/demo.gif`).
- GCS sync copies only `.py` files and skips `tests/` and `__pycache__/` (configurable with `dbtAirflow.dagsSyncExclude`), so test data in a bucket is never downloaded.
- GCS sync falls back to `gsutil` when `gcloud` itself crashes, and explains the crash.
- The cache marker now lives outside the mirrored folder, so pruning can no longer delete it.
- The graph area and dialogs follow the real height of the top bar, so **Fit** no longer slides the first row of nodes under it in narrow panels.

## 0.1.0 — first public release

- Interactive lineage graph from `target/manifest.json` (drag, pan, zoom, animated links for the selected node).
- Built-in dbt selector engine: names, `tag:`, `path:`, `source:`, `package:`, `config.*`, `+` / `N+` / `@`, union, intersection, `--exclude`, named selectors from `selectors.yml`.
- Floating selector search, filter popover (select / exclude / types), find-in-graph, legend.
- Optional Airflow pipelines: which DAG runs a model (dbt selectors) and which DAG ingests a table (BigQuery dataset + table in DAG code).
- Airflow source setup wizard: local folder or Google Cloud Storage (bucket browser, access test, sign-in recovery).
- Model details dialog that edits the model's YAML in place: description, tags, config, meta, tests, columns.
