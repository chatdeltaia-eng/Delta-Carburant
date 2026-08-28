import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  private queryLabel(text: string) {
    return text.replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  private enrich(error: unknown, text: string) {
    if (error instanceof Error && !error.message.includes('[SQL:'))
      error.message = `${error.message} [SQL: ${this.queryLabel(text)}]`;
    return error;
  }

  async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    try {
      const result = await this.pool.query<T>(text, values);
      return result.rows;
    } catch (error) {
      throw this.enrich(error, text);
    }
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let lastQuery = 'transaction non démarrée';
    const originalQuery = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      const input = args[0] as string | { text?: string };
      lastQuery = typeof input === 'string' ? input : input?.text ?? 'requête inconnue';
      return originalQuery(...args as Parameters<typeof originalQuery>);
    }) as typeof client.query;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      const failedQuery = lastQuery;
      await client.query('ROLLBACK');
      throw this.enrich(error, failedQuery);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() { await this.pool.end(); }
}
