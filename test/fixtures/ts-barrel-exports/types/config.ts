/**
 * Config types
 */

export interface AppConfig {
  port: number;
  host: string;
}

export interface DatabaseConfig {
  url: string;
  pool: number;
}
