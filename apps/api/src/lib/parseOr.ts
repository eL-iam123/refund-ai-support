import { badRequest } from '../http/errors.js';
import type { z } from 'zod';

export function parseOr<T>(result: { success: true; data: T } | { success: false; error: z.ZodError }, what: string): T {
  if (result.success) {
    return result.data;
  }
  throw badRequest(`invalid ${what}`, result.error.issues.map((issue) => issue.message));
}
