import { conflict } from '../http/errors.js';

export function toConflict(code: string, error: unknown): Error {
  if (error instanceof Error) {
    return conflict(code, error.message);
  }
  return conflict(code, String(error));
}
