import 'server-only';
import { createHash } from 'node:crypto';
import { ProviderFailed } from './types';
import type { VideoGenerationProvider, VideoJob, VideoRequest, VideoStatus } from './types';

/**
 * A deterministic video provider for tests.
 *
 * Video generation is asynchronous everywhere, so the fake is asynchronous
 * too: submit() returns a handle and poll() reports 'pending' until the job
 * has been asked about `readyAfterPolls` times. A fake that completed
 * immediately would let the whole queue-and-poll path go untested, which is
 * the part most likely to be wrong.
 *
 * The bytes are a real MP4 container header followed by deterministic filler.
 * That is enough for content type, size and storage round-trip to be exercised
 * honestly; it is not a playable video, and nothing here pretends it is.
 */
export class FakeVideoProvider implements VideoGenerationProvider {
  readonly name = 'fake-video' as const;
  readonly model = 'fake-video-1';
  readonly configured = true;
  readonly resolutions = ['480p', '720p'] as const;
  readonly supportsCancel = true;

  /** Polls before a job reports completion. 0 means the first poll is ready. */
  readyAfterPolls = 1;
  /** Set by tests to see the failure path. */
  failWith: ProviderFailed | null = null;
  /** Set by tests to make the provider report a failed job rather than throw. */
  failJob: { code: 'PROVIDER_ERROR' | 'GENERATION_FAILED'; message: string } | null = null;

  private polls = new Map<string, number>();
  private prompts = new Map<string, string>();
  private cancelled = new Set<string>();

  async submit(request: VideoRequest): Promise<VideoJob> {
    if (this.failWith) throw this.failWith;
    if (request.prompt.trim().length === 0) {
      throw new ProviderFailed('INVALID_REQUEST', 'permanent', 'A prompt is required.');
    }

    const providerJobId = `fake-job-${createHash('sha256')
      .update(request.prompt)
      .update(String(this.polls.size))
      .digest('hex')
      .slice(0, 16)}`;

    this.polls.set(providerJobId, 0);
    this.prompts.set(providerJobId, request.prompt);

    return {
      providerJobId,
      model: this.model,
      usage: { providerRequestId: providerJobId, inputUnits: request.prompt.length },
    };
  }

  async poll(providerJobId: string): Promise<VideoStatus> {
    if (this.cancelled.has(providerJobId)) {
      return { state: 'failed', code: 'CANCELLED', message: 'The generation was cancelled.' };
    }
    if (this.failJob) {
      return { state: 'failed', code: this.failJob.code, message: this.failJob.message };
    }

    const seen = (this.polls.get(providerJobId) ?? 0) + 1;
    this.polls.set(providerJobId, seen);
    if (seen <= this.readyAfterPolls) return { state: 'pending' };

    const prompt = this.prompts.get(providerJobId) ?? providerJobId;
    return {
      state: 'completed',
      assets: [
        {
          bytes: fakeMp4(prompt),
          mimeType: 'video/mp4',
          width: 640,
          height: 360,
          durationSeconds: 5,
        },
      ],
      usage: { providerRequestId: providerJobId, outputUnits: 1 },
    };
  }

  async cancel(providerJobId: string): Promise<void> {
    this.cancelled.add(providerJobId);
  }

  /** Tests reuse one provider across cases and need it to forget. */
  reset(): void {
    this.polls.clear();
    this.prompts.clear();
    this.cancelled.clear();
    this.readyAfterPolls = 1;
    this.failWith = null;
    this.failJob = null;
  }
}

/** An ftyp box, then deterministic filler. Enough to be recognisably an MP4. */
function fakeMp4(seed: string): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from('isom', 'ascii'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2', 'ascii'),
  ]);

  const filler = Buffer.alloc(1024);
  const hash = createHash('sha256').update(seed).digest();
  for (let i = 0; i < filler.length; i += 1) filler[i] = hash[i % hash.length]!;

  return Buffer.concat([ftyp, filler]);
}
