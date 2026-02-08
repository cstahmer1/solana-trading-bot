import pg from "pg";
import { env } from "./config.js";

function getDatabaseUrl(): string {
  const isProduction = env.IS_PRODUCTION === "true";
  if (isProduction && env.PROD_DATABASE_URL) {
    return env.PROD_DATABASE_URL;
  }
  return env.DATABASE_URL;
}

export const pool = new pg.Pool({
  connectionString: getDatabaseUrl(),
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}
