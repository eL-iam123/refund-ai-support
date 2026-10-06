import { NotFoundError } from '../http/errors.js';

export function existingOr404<T>(find: () => T | null, kind: string, id: string): T {
  const found = find();
  if (found === null) {
    throw new NotFoundError(kind, id);
  }
  return found;
}
