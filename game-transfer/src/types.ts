export interface CatalogShare {
  provider: string;
  url: string;
  code: string | null;
}

export interface CatalogGame {
  id: number;
  source_url: string;
  raw_title: string;
  parsed_name?: string;
  safe_name: string;
  shares: CatalogShare[];
}

export interface CatalogFile {
  schema_version: number;
  source: {
    month: string;
  };
  games: CatalogGame[];
}

export interface TransferPlanItem {
  post_id: number;
  game_name: string;
  source_url: string;
  target_dir: string;
  share_url: string;
  share_code: string | null;
  share_fingerprint: string;
}

export type TransferStatus = 'submitted' | 'completed' | 'failed';

export interface TransferRecord {
  post_id: number;
  game_name: string;
  provider: 'baidu';
  share_fingerprint: string;
  target_dir: string;
  status: TransferStatus;
  task_id: string | null;
  saved_paths: string[];
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export interface TransferStateFile {
  schema_version: 1;
  source: {
    catalog_path: string;
    month: string;
  };
  updated_at: string;
  records: Record<string, TransferRecord>;
}

export interface InterpretedTransferResult {
  status: 'submitted' | 'completed';
  taskId: string | null;
  savedPaths: string[];
}
