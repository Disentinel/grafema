export interface QueryResult {
  rows: Record<string, unknown>[];
}

let pool: unknown = null;

export function connect(connectionString: string): void {
  pool = { connectionString, connected: true };
}

export async function query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  if (!pool) throw new Error('Database not connected');
  // Simulated query
  return [];
}

export async function disconnect(): Promise<void> {
  pool = null;
}
