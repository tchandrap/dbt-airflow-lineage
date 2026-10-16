# Changelog

## 0.1.2 — 2026-10-16

- Renamed the display name to **dbt airflow lineage** (lowercase). The extension ID `tchandrap.dbt-airflow-lineage` is unchanged, so updates keep working. The activity bar, bottom panel and output channel use the same name.
- New icon: the dbt logo, the Airflow logo and the lineage graph.
- Refocusing a model now zooms in on it.
- Switching to another model file resets Upstream and Downstream to 2 and 2.
- Reloading (manifest or DAG changes, Sync DAGs) happens in the background: a thin progress bar shows it, and the graph stays usable.
- Explore beyond your levels: the models at the edge of the graph have a **+** button that shows their downstream (right side) or upstream (left side) models. It is for exploring only and does not change the Upstream/Downstream numbers. A + only shows where nothing of that side is on screen yet, and it reveals only that model's neighbours.
- Typing a model name in the selector now selects only that model, like dbt. "Include upstream / downstream lineage" in the filter dialog is off by default; `1+model+1` style selectors still show their own lineage.
- The details, Airflow and filter dialogs can be resized: drag their inner edge (width) or, for details and Airflow, the bottom edge (height).
- The legend is smaller: node types (materialization for models) and the feeds / fed by lines.
- When the gcloud login is missing or expired, the DAG sync error has a **Sign in with gcloud** button that signs in and retries.
- The search box always shows the shortest **dbt selector** for the models on screen (`2+model+2`, `+model`, `model+1 other+1` after clicking +). Edit it and press Enter to search.

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
