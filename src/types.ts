export interface GNode {
  id: string;
  name: string;
  type: 'model' | 'seed' | 'snapshot' | 'source' | 'exposure';
  tags: string[];
  fqn: string[];
  path: string; // original_file_path
  pkg: string;
  materialized?: string;
  group?: string | null;
  access?: string | null;
  sourceName?: string;
  patchPath?: string; // YAML properties file, e.g. "pkg://models/x/y.yml"
  schema?: string; // BigQuery dataset the relation lives in
  table?: string; // BigQuery table / view name (case-sensitive in BigQuery)
}

/** Selector definition as stored in manifest.selectors[name].definition */
export type SelectorDef = any;

export interface Graph {
  nodes: Record<string, GNode>;
  parents: Record<string, string[]>; // only between GNode ids (tests/analyses removed)
  children: Record<string, string[]>;
  selectors: Record<string, SelectorDef>;
  generatedAt?: string;
}

export interface SelectionSite {
  select: string | null; // null = could not be resolved statically
  exclude: string | null;
  namedSelector?: string; // --selector NAME
  dynamic: boolean; // true if any part was not statically resolvable
  jobName?: string;
  indirect?: string;
  line: number;
  raw: string;
}

/** A BigQuery table that a pipeline loads data into (found in the DAG code, e.g. `bq_dataset` + `bq_table`). */
export interface IngestRef {
  dataset?: string;
  table: string;
  line: number;
  via: string; // the key or pattern it was found under, for display
}

export interface Pipeline {
  id: string;
  name: string;
  file: string;
  line: number;
  schedule?: string;
  sites: SelectionSite[];
  ingests?: IngestRef[];
}
