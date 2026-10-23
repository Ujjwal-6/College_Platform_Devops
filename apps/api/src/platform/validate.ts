import type { ZodType } from 'zod';
import { errors, zodDetails } from './errors.js';

/**
 * Parses untrusted input (body, query, params) with a zod schema.
 * Schemas should be `.strict()` so unknown fields are rejected.
 */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw errors.validation(zodDetails(result.error));
  }
  return result.data;
}
