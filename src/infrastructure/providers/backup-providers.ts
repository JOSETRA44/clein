import { ExternalToolError } from '../../domain/errors.js';
import type { BackupProvider } from '../../application/ports.js';

/** Backups already live on local disk; this provider exists so callers can treat destinations uniformly. */
export class LocalProvider implements BackupProvider {
  readonly name = 'local';
  async upload(): Promise<void> {}
  async resume(): Promise<void> {}
}

export class TelegramMtprotoProvider implements BackupProvider {
  readonly name = 'telegram-mtproto';

  async upload(): Promise<void> {
    throw new ExternalToolError('Telegram MTProto user provider requires TELEGRAM_API_ID, TELEGRAM_API_HASH and an authorized user session; configure it before enabling uploads');
  }

  async resume(): Promise<void> {
    throw new ExternalToolError('Telegram provider is not configured');
  }
}
