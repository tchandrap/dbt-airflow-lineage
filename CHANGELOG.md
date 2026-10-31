# Changelog

## Unreleased

- Optional AI (off by default, `dbtAirflow.ai.enabled`): ask your editor's AI agent which reports a model change impacts, which pipelines run it, what a selector picks. Settings `dbtAirflow.reports.include` / `exclude` define a report: a list of sources that are combined (`exposures`, `tag:report`, `folder:reporting`, `file:rpt_pnl.sql`, `path:…`, or any dbt selector), minus an exclude list.
- **Ask AI** button, command and shortcut (Cmd+Alt+A). The first click asks for confirmation. In VS Code it opens the chat in Agent mode; in Cursor it sets up a local MCP server (bundled, read-only, no network) and copies the question.
- Local MCP server for Cursor's agent. After you turn AI on, the extension asks which other AI tools should use it: Claude Code (terminal command), Claude Desktop (adds to its config, with a backup), OpenAI Codex CLI, or any MCP client. Re-run it any time with **dbt Airflow: Connect an AI tool to the lineage**. ChatGPT only connects to remote servers, so it cannot use this local one.
- Google Cloud sign-in for DAG sync now opens the sign-in page itself instead of relying on gcloud launching a browser.
- Progress bars with "Step i of N" messages for the long jobs: loading the project (reading the manifest, scanning the DAGs, building the index), the DAG download (with a file count), the Google sign-in, setting up AI and connecting AI tools. The graph view shows the current step next to its busy bar.
- **Sync DAGs** is the only Airflow button: the first click asks where the pipelines come from, after that it just syncs. The gear button is gone (the command **dbt Airflow: Set up Airflow** still changes the source).
- **Impact** button (no AI needed): shows only the paths from the focused model to the reports it affects, in red, with a panel listing each report, its path and the Airflow pipelines that run it. The first click opens a picker where you add as many report sources as you like (exposures, tags, folders, files, dbt selectors, and excludes), each with how many reports it matches; change it any time with **dbt Airflow: Choose what counts as a report…**. Until something is set, the Impact panel shows how to set it up.
- **Critical models** next to reports: settings `dbtAirflow.critical.include` / `exclude` (same entries as reports, e.g. `tag:critical`, `folder:regulatory_reports`) and the command **dbt Airflow: Choose which models are critical…**. A change shows both groups (critical models in amber, reports in red) and each pipeline with its schedule. The AI answers include them too.
- **Save the lineage as an image**: the download button in the bottom bar (or the command **dbt Airflow: Save the lineage as an image…**) saves the whole graph as an SVG (vector, stays sharp at any zoom) or as a PNG at 3x or 6x resolution, in the theme colors you see.
- A gear button opens this extension's settings, and every setting now has a description with examples.
- Requires VS Code 1.95 or newer.

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
