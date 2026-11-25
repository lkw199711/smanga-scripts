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
  transfer_dir: string;
  target_dir: string;
  share_url: string;
  share_code: string | null;
  share_fingerprint: string;
}

export interface TransferredItem {
  name: string;
  path: string;
  saved_path: string | null;
  is_dir: boolean;
}

export type TransferStatus = 'submitted' | 'transferred' | 'completed' | 'failed';

export interface TransferRecord {
  post_id: number;
  game_name: string;
  provider: 'baidu';
  share_fingerprint: string;
  transfer_dir: string;
  target_dir: string;
  status: TransferStatus;
  task_id: string | null;
  saved_paths: string[];
  transferred_items: TransferredItem[];
  final_path: string | null;
  /** 2 表示目录已经按“月份/正式游戏名”整理为单层结构。 */
  layout_version?: 2;
  /** 旧版双层目录修复时保存的内层目录，供中断后安全续跑。 */
  repair_source_path?: string | null;
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
  items: TransferredItem[];
}
