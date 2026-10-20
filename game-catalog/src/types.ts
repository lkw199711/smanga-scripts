export type ShareStatus = 'discovered';

export interface ShareRecord {
  provider: string;
  label: string;
  host: string;
  url: string;
  code: string | null;
  code_label: string | null;
  position: number;
  raw_text: string;
  status: ShareStatus;
  share_name: string | null;
  remote_files: string[];
}

export interface DescriptionImage {
  url: string;
  alt: string | null;
}

export interface GameDescription {
  text: string;
  html: string;
  images: DescriptionImage[];
}

export interface GameRecord {
  id: number;
  published_at: string;
  published_at_gmt: string;
  modified_at: string;
  source_url: string;
  slug: string;
  raw_title: string;
  parsed_name: string;
  safe_name: string;
  name_override: string | null;
  name_confidence: 'source-title';
  description: GameDescription;
  shares: ShareRecord[];
  extract_password: string | null;
  content_html_raw: string;
  warnings: string[];
}

export interface CrawlFailure {
  id: number;
  source_url: string;
  title: string;
  error: string;
}

export interface CatalogFile {
  schema_version: 1;
  source: {
    site: string;
    category_id: number;
    month: string;
    fetched_at: string;
  };
  summary: {
    discovered: number;
    scraped: number;
    failed: number;
    articles_without_shares: number;
    provider_counts: Record<string, number>;
  };
  games: GameRecord[];
  failures: CrawlFailure[];
}

export interface WordPressPost {
  id: number;
  date: string;
  date_gmt: string;
  modified: string;
  slug: string;
  link: string;
  title: {
    rendered: string;
  };
}
