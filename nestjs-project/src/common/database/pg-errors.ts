import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

/** True when `err` is a Postgres unique violation whose detail mentions `column`. */
export function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  // QueryFailedError copies the pg driver error fields (code, detail) onto itself.
  const { code, detail } = err as QueryFailedError & {
    code?: string;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(`(${column})`)
  );
}
