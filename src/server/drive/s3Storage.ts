import 'server-only';
import { createHash, createHmac } from 'node:crypto';
import { assertSafeKey } from './storage';
import type { DriveStorage } from './storage';

/**
 * Any S3-compatible object store - Backblaze B2, Cloudflare R2, AWS S3 -
 * reached over its REST API.
 *
 * No SDK, for the same reason as the Supabase driver: three calls, each a
 * plain HTTP request, signed with AWS Signature Version 4. The bucket is
 * private and only this server holds the key; isolation between companies
 * lives in the database, which decides whether a key may be read at all.
 *
 * Added when the Supabase project ran past its free storage and was
 * restricted: B2 gives ten free gigabytes and charges nothing to read them.
 */
export class S3Storage implements DriveStorage {
  readonly name = 's3-storage';

  /** S3 takes up to 5 GB in one request. CIP never sends more than its own file limit. */
  get maxObjectBytes(): number {
    const configured = Number(process.env.CIP_STORAGE_MAX_OBJECT_BYTES);
    return Number.isFinite(configured) && configured > 0 ? configured : 500 * 1024 * 1024;
  }

  private readonly host: string;
  private readonly region: string;

  constructor(
    endpoint: string,
    private readonly bucket: string,
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
    region?: string,
  ) {
    this.host = endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    // "s3.us-east-005.backblazeb2.com" is in us-east-005; R2 calls itself "auto".
    this.region = region ?? this.host.match(/^s3\.([a-z0-9-]+)\./)?.[1] ?? 'auto';
  }

  private path(key: string): string {
    assertSafeKey(key);
    return `/${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** One signed request. Path-style, so the bucket name never has to be a valid hostname. */
  private async send(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, contentType?: string): Promise<Response> {
    const path = this.path(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');

    const headers: Record<string, string> = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;

    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      '',
      ...names.map((n) => `${n}:${headers[n]!.trim()}`),
      '',
      names.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${day}/${this.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');

    const hmac = (k: Buffer | string, data: string) => createHmac('sha256', k).update(data).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, day), this.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');

    const { host: _host, ...sent } = headers;
    return fetch(`https://${this.host}${path}`, {
      method,
      headers: {
        ...sent,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
      },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await this.send('PUT', key, body, contentType);
    if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${await safeText(res)}`);
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.send('GET', key);
    if (!res.ok) throw new Error(`Storage read failed (${res.status}): ${await safeText(res)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    const res = await this.send('DELETE', key);
    // A missing object is already the state we wanted.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Storage delete failed (${res.status}): ${await safeText(res)}`);
    }
  }
}

/** Error bodies are echoed back to logs, so never let a credential ride along. */
async function safeText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.replace(/Credential=[^,\s]+/g, 'Credential=…').slice(0, 300);
}
