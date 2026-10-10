export interface BackupProvider { readonly name: string; upload(stream: AsyncIterable<Uint8Array>, metadata: Record<string, unknown>): Promise<void>; resume(jobId: string): Promise<void>; }
export class LocalProvider implements BackupProvider { readonly name = 'local'; async upload() {} async resume() {} }
export class TelegramMtprotoProvider implements BackupProvider {
  readonly name = 'telegram-mtproto';
  async upload(): Promise<void> { throw new Error('Telegram MTProto user provider requires TELEGRAM_API_ID, TELEGRAM_API_HASH and an authorized user session; configure it before enabling uploads'); }
  async resume(): Promise<void> { throw new Error('Telegram provider is not configured'); }
}
