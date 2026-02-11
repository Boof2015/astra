declare module 'sql.js' {
  export interface QueryExecResult {
    columns: string[]
    values: unknown[][]
  }

  export interface Statement {
    bind(values?: unknown[]): void
    step(): boolean
    getAsObject<T = Record<string, unknown>>(): T
    free(): void
  }

  export interface Database {
    run(sql: string, params?: unknown[]): void
    exec(sql: string): QueryExecResult[]
    prepare(sql: string): Statement
    export(): Uint8Array
    close(): void
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database
  }

  export default function initSqlJs(config?: { locateFile?: (filename: string) => string }): Promise<SqlJsStatic>
}
