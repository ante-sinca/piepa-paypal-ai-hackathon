declare module "node:sqlite" {
  export type SqliteRow = Record<string, unknown>;

  export class StatementSync {
    get(...parameters: unknown[]): SqliteRow | undefined;
    all(...parameters: unknown[]): SqliteRow[];
    run(...parameters: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string, options?: { timeout?: number; defensive?: boolean; enableForeignKeyConstraints?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export function backup(sourceDb: DatabaseSync, path: string, options?: { rate?: number }): Promise<number>;
}
