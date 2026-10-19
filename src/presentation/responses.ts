import { AppError, type ErrorCode } from '../domain/errors.js';

export interface SuccessPayload<T> { success: true; data: T }
export interface ErrorPayload { success: false; error: { code: ErrorCode | 'INTERNAL'; message: string } }

export function successPayload<T>(data: T): SuccessPayload<T> {
  return { success: true, data };
}

export function errorPayload(error: unknown): ErrorPayload {
  if (error instanceof AppError) return { success: false, error: { code: error.code, message: error.message } };
  return { success: false, error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } };
}

const EXIT_CODES: Record<ErrorPayload['error']['code'], number> = {
  INTERNAL: 1,
  EXTERNAL_TOOL: 1,
  INVALID_STATE: 1,
  VALIDATION: 2,
  NOT_FOUND: 3,
  DEVICE_UNAVAILABLE: 4,
  INTEGRITY: 5,
  CONFIRMATION_REQUIRED: 6,
  POLICY_DENIED: 7
};

export function exitCodeFor(payload: ErrorPayload): number {
  return EXIT_CODES[payload.error.code];
}
