import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { errorText } from './errors';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
/** 迁移用的咨询锁编号：多个进程同时启动时只有一个在执行迁移。 */
const MIGRATION_LOCK_ID = 725_001;

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000 });
  // 空闲连接断开时 pg 会在连接池上触发 error，不监听的话进程会直接退出。
  pool.on('error', (err) => console.error(`[db] 空闲连接出错：${errorText(err)}`));
  return pool;
}

/** 按文件名顺序执行 migrations/ 里还没执行过的 SQL，返回这次执行了哪些。 */
export async function migrate(pool: Pool): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name       text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const done = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
      const applied = new Set(done.rows.map((r) => r.name));
      const ran: string[] = [];
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(fileURLToPath(new URL(file, MIGRATIONS_DIR)), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`迁移 ${file} 失败：${errorText(err)}`, { cause: err });
        }
        ran.push(file);
      }
      return ran;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
