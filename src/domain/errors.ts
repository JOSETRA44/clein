/**
 * Error vocabulary shared by every layer. Outer layers translate these codes
 * into exit codes (CLI) or tool results (MCP); nothing else needs to inspect
 * error messages to decide what went wrong.
 */
export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'DEVICE_UNAVAILABLE'
  | 'INTEGRITY'
  | 'INVALID_STATE'
  | 'EXTERNAL_TOOL'
  | 'CONFIRMATION_REQUIRED'
  | 'POLICY_DENIED';

export class AppError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) { super('VALIDATION', message); }
}

export class NotFoundError extends AppError {
  constructor(message: string) { super('NOT_FOUND', message); }
}

export class DeviceUnavailableError extends AppError {
  constructor(message: string) { super('DEVICE_UNAVAILABLE', message); }
}

export class IntegrityError extends AppError {
  constructor(message: string) { super('INTEGRITY', message); }
}

export class InvalidStateError extends AppError {
  constructor(message: string) { super('INVALID_STATE', message); }
}

export class ExternalToolError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) { super('EXTERNAL_TOOL', message, options); }
}

export class ConfirmationRequiredError extends AppError {
  constructor(message: string) { super('CONFIRMATION_REQUIRED', message); }
}

export class PolicyDeniedError extends AppError {
  constructor(message: string) { super('POLICY_DENIED', message); }
}

/** Policy: operations that change device state must be explicitly confirmed by the caller. */
export function assertConfirmed(confirmed: boolean | undefined, action: string): void {
  if (confirmed !== true) {
    throw new ConfirmationRequiredError(`${action} changes the device; re-run with confirmation (--yes / confirm: true)`);
  }
}
