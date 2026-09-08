import 'server-only';
import { BRAIN_LIMITS, BrainFailed, TASK_TYPES, normaliseTaskType } from './types';
import type {
  AssetAnalysis,
  BrainProvider,
  BrainUsage,
  BriefInput,
  DocumentInput,
  FeedbackAnalysis,
  FeedbackInput,
  FramesInput,
  GenerationBrief,
  ImageInput,
} from './types';

/**
 * The Brain, on OpenAI.
 *
 * Plain fetch against the official API, which is how the embedder and the
 * image provider already talk to OpenAI. Every call asks for a JSON schema
 * with `strict: true`, so the response either matches the shape this file
 * expects or the request fails — there is no parsing of prose into structure,
 * and no place for a malformed answer to become a confident-looking record.
 *
 * Verified against the live API rather than assumed: gpt-5 models bill
 * reasoning tokens against max_completion_tokens, so a budget sized for the
 * answer alone comes back empty with finish_reason "stop". The budgets here
 * account for that, and `reasoning_effort` is set low because this is
 * extraction rather than deduction.
 *
 * PRIVACY: this sends asset content — image bytes, sampled frames, extracted
 * text — and the user's own request. It sends nothing else: no company id, no
 * file id, no storage path, no database id. Neither request nor response is
 * ever logged, because both contain the customer's content.
 */

const DEFAULT_MODEL = 'gpt-5-mini';
const BASE_URL = 'https://api.openai.com/v1';

/** Reused across every schema: a claim small enough to count evidence for. */
const FACT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['section', 'attribute', 'value'],
    properties: {
      section: { type: 'string', enum: ['visual', 'video', 'content'] },
      attribute: { type: 'string' },
      value: { type: 'string' },
    },
  },
} as const;

const ASSET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'extractedText', 'structured', 'facts'],
  properties: {
    summary: { type: 'string' },
    extractedText: { type: ['string', 'null'] },
    structured: {
      type: 'object',
      additionalProperties: false,
      required: [
        'objects', 'products', 'brandElements', 'logoPresent', 'colours',
        'typography', 'composition', 'background', 'lighting', 'style',
        'mood', 'contentType',
      ],
      properties: {
        objects: { type: 'array', items: { type: 'string' } },
        products: { type: 'array', items: { type: 'string' } },
        brandElements: { type: 'array', items: { type: 'string' } },
        logoPresent: { type: 'boolean' },
        colours: { type: 'array', items: { type: 'string' } },
        typography: { type: 'array', items: { type: 'string' } },
        composition: { type: 'string' },
        background: { type: 'string' },
        lighting: { type: 'string' },
        style: { type: 'string' },
        mood: { type: 'string' },
        contentType: { type: 'string' },
      },
    },
    facts: FACT_SCHEMA,
  },
} as const;

const VIDEO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'extractedText', 'structured', 'facts'],
  properties: {
    summary: { type: 'string' },
    extractedText: { type: ['string', 'null'] },
    structured: {
      type: 'object',
      additionalProperties: false,
      required: [
        'shotTypes', 'cameraMovement', 'pacing', 'transitions', 'textOverlays',
        'products', 'brandElements', 'colours', 'style', 'mood', 'contentType', 'scenes',
      ],
      properties: {
        shotTypes: { type: 'array', items: { type: 'string' } },
        cameraMovement: { type: 'array', items: { type: 'string' } },
        pacing: { type: 'string' },
        transitions: { type: 'array', items: { type: 'string' } },
        textOverlays: { type: 'array', items: { type: 'string' } },
        products: { type: 'array', items: { type: 'string' } },
        brandElements: { type: 'array', items: { type: 'string' } },
        colours: { type: 'array', items: { type: 'string' } },
        style: { type: 'string' },
        mood: { type: 'string' },
        contentType: { type: 'string' },
        scenes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['atSeconds', 'describes'],
            properties: {
              atSeconds: { type: 'number' },
              describes: { type: 'string' },
            },
          },
        },
      },
    },
    facts: FACT_SCHEMA,
  },
} as const;

const FEEDBACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lessons'],
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['polarity', 'statement', 'appliesTo', 'confidence'],
        properties: {
          polarity: { type: 'string', enum: ['prefer', 'avoid'] },
          statement: { type: 'string' },
          appliesTo: {
            type: 'string',
            enum: ['company', 'task_type', 'campaign', 'product', 'platform'],
          },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'taskType', 'platform', 'campaign', 'product', 'visualDirection',
    'videoDirection', 'contentDirection', 'brandRules', 'successfulPatterns',
    'negativePatterns', 'learnedPreferences', 'constraints', 'avoid',
    'generationPrompt', 'confidence', 'clarificationQuestion',
  ],
  properties: {
    taskType: { type: 'string', enum: [...TASK_TYPES] },
    platform: { type: ['string', 'null'] },
    campaign: { type: ['string', 'null'] },
    product: { type: ['string', 'null'] },
    visualDirection: { type: ['string', 'null'] },
    videoDirection: { type: ['string', 'null'] },
    contentDirection: { type: ['string', 'null'] },
    brandRules: { type: 'array', items: { type: 'string' } },
    successfulPatterns: { type: 'array', items: { type: 'string' } },
    negativePatterns: { type: 'array', items: { type: 'string' } },
    learnedPreferences: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    avoid: { type: 'array', items: { type: 'string' } },
    generationPrompt: { type: 'string' },
    confidence: { type: 'number' },
    clarificationQuestion: { type: ['string', 'null'] },
  },
} as const;

type Content =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' | 'low' | 'high' } };

export class OpenAIBrainProvider implements BrainProvider {
  readonly name = 'openai' as const;
  readonly model: string;
  readonly configured: boolean;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(apiKey: string | undefined, model = DEFAULT_MODEL, baseUrl = BASE_URL) {
    this.apiKey = apiKey;
    this.model = model;
    this.configured = Boolean(apiKey);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async analyzeImage(input: ImageInput): Promise<AssetAnalysis> {
    if (input.bytes.byteLength > BRAIN_LIMITS.maxImageBytes) {
      throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'That image is too large to analyse.');
    }

    // A vision model given a thumbnail does not say "too small" — it invents a
    // confident description of something that is not there. Verified: an 8x8
    // image produced a detailed account of a forest. So anything below a usable
    // size is refused rather than analysed.
    const size = pngOrJpegSize(input.bytes);
    if (size && Math.min(size.width, size.height) < BRAIN_LIMITS.minImagePixels) {
      throw new BrainFailed(
        'ASSET_TOO_SMALL',
        'permanent',
        'That image is too small to describe reliably.',
      );
    }

    const content: Content[] = [
      {
        type: 'text',
        text:
          `Analyse this brand asset named "${input.filename}". Describe only what is ` +
          'actually visible. Do not guess at a brand, product or campaign that is not ' +
          'shown. Leave a field empty rather than inventing a value. Extract any text ' +
          'you can read verbatim. Facts should be small, individually checkable claims ' +
          'about what is present. Never record an absence as a fact: if there is no ' +
          'logo, no visible text or no discernible style, simply omit it.',
      },
      {
        type: 'image_url',
        image_url: { url: dataUri(input.mimeType, input.bytes), detail: 'auto' },
      },
    ];

    return this.analyse(content, ASSET_SCHEMA, 'asset_analysis');
  }

  async analyzeFrames(input: FramesInput): Promise<AssetAnalysis> {
    if (input.frames.length === 0) {
      throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'No frames could be sampled.');
    }

    const spoken = input.transcript?.trim();
    const content: Content[] = [
      {
        type: 'text',
        text:
          `Analyse this video named "${input.filename}" from ${input.frames.length} sampled ` +
          `frames spanning ${Math.round(input.durationSeconds)} seconds` +
          (input.width && input.height ? ` at ${input.width}x${input.height}` : '') +
          '. The frames are in chronological order and are a sample, not every frame — ' +
          'infer shot types, camera movement, pacing and transitions from how they change, ' +
          'and say so conservatively. Describe only what is visible. ' +
          (spoken ? 'A transcript of the audio follows the frames.' : 'No audio transcript is available.'),
      },
      ...input.frames.map(
        (frame): Content => ({
          type: 'image_url',
          image_url: { url: dataUri(frame.mimeType, frame.bytes), detail: 'auto' },
        }),
      ),
    ];

    if (spoken) {
      content.push({ type: 'text', text: `Transcript:\n${spoken.slice(0, 6_000)}` });
    }

    return this.analyse(content, VIDEO_SCHEMA, 'video_analysis');
  }

  async analyzeDocument(input: DocumentInput): Promise<AssetAnalysis> {
    const text = input.text.slice(0, BRAIN_LIMITS.maxDocumentChars);
    if (text.trim().length === 0) {
      throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'That document has no readable text.');
    }

    const content: Content[] = [
      {
        type: 'text',
        text:
          `Analyse this brand document named "${input.filename}". Identify tone of voice, ` +
          'vocabulary, calls to action, messaging patterns, products and campaigns it ' +
          'names, and any explicit brand rules it states. Report only what the document ' +
          `actually says.\n\n${text}`,
      },
    ];

    return this.analyse(content, ASSET_SCHEMA, 'document_analysis');
  }

  async analyzeFeedback(input: FeedbackInput): Promise<FeedbackAnalysis> {
    const scope = [
      `task type: ${input.taskType}`,
      input.platform ? `platform: ${input.platform}` : null,
      input.campaign ? `campaign: ${input.campaign}` : null,
      input.product ? `product: ${input.product}` : null,
    ].filter(Boolean).join(', ');

    const content: Content[] = [
      {
        type: 'text',
        text:
          'Somebody rated a generated asset and may have said why. Turn that into ' +
          'lessons for future generations.\n\n' +
          `They asked for: ${input.requestText}\n` +
          `Context: ${scope}\n` +
          `Score: ${input.score} out of 10\n` +
          `Comment: ${input.comment ?? '(none)'}\n\n` +
          'Rules. Return no lessons at all when the feedback teaches nothing specific — ' +
          'a bare score with no comment usually teaches nothing. Say what each lesson ' +
          'applies to as narrowly as the evidence supports: prefer campaign or product ' +
          'scope over company-wide, because a preference expressed about one campaign is ' +
          'not a rule for the whole brand. Each statement must be a single actionable ' +
          'instruction.',
      },
    ];

    const { parsed, usage } = await this.call<{ lessons: FeedbackAnalysis['lessons'] }>(
      content, FEEDBACK_SCHEMA, 'feedback_analysis', 2_500,
    );

    return {
      lessons: parsed.lessons
        .filter((lesson) => lesson.statement.trim().length > 0)
        .map((lesson) => ({ ...lesson, confidence: clamp(lesson.confidence) })),
      usage,
    };
  }

  async buildGenerationBrief(input: BriefInput): Promise<GenerationBrief & { usage: BrainUsage }> {
    const sections: string[] = [
      `The person asked: ${input.requestText}`,
      `They want: ${input.mediaType === 'video' ? 'a video' : 'an image'}`,
    ];

    if (input.brandFacts.length > 0) {
      sections.push(
        'What is known about this brand, from its own assets:\n' +
          input.brandFacts
            .map((f) => `- [${f.section}] ${f.attribute}: ${f.value} (confidence ${f.confidence.toFixed(2)})`)
            .join('\n'),
      );
    }
    if (input.relevantAssets.length > 0) {
      sections.push(
        'Existing assets that resemble this request:\n' +
          input.relevantAssets.map((a) => `- ${a.summary}`).join('\n'),
      );
    }
    if (input.successfulExamples.length > 0) {
      sections.push(
        'Past generations this company rated highly:\n' +
          input.successfulExamples
            .map((e) => `- "${e.requestText}" scored ${e.score}/10${e.comment ? ` — ${e.comment}` : ''}`)
            .join('\n'),
      );
    }
    if (input.negativeExamples.length > 0) {
      sections.push(
        'Past generations this company rated poorly, to avoid repeating:\n' +
          input.negativeExamples
            .map((e) => `- "${e.requestText}" scored ${e.score}/10${e.comment ? ` — ${e.comment}` : ''}`)
            .join('\n'),
      );
    }
    if (input.lessons.length > 0) {
      sections.push(
        'Lessons learned from this company’s own feedback:\n' +
          input.lessons.map((l) => `- ${l.polarity}: ${l.statement}`).join('\n'),
      );
    }
    if (input.knownCampaigns.length > 0) {
      sections.push(`Campaigns this company has assets for: ${input.knownCampaigns.join(', ')}`);
    }
    if (input.knownProducts.length > 0) {
      sections.push(`Products this company has assets for: ${input.knownProducts.join(', ')}`);
    }

    sections.push(
      'Build a production brief. The generation prompt must be concrete and ' +
        'self-contained — it is sent straight to an image or video model that ' +
        'has none of the context above.\n\n' +
        'Only invent what the request needs and the brand evidence supports; do not ' +
        'assert brand details that are not listed above. Set confidence honestly: low ' +
        'when there is little or no brand evidence to work from.\n\n' +
        'Ask a clarification question only when you genuinely cannot proceed — for ' +
        'example several campaigns or products exist and nothing in the request or the ' +
        'evidence identifies which one is meant. If the request is workable, set ' +
        'clarificationQuestion to null and proceed. Do not ask about things you can ' +
        'reasonably decide yourself.',
    );

    const { parsed, usage } = await this.call<GenerationBrief>(
      [{ type: 'text', text: sections.join('\n\n') }],
      BRIEF_SCHEMA,
      'generation_brief',
      4_000,
    );

    return {
      ...parsed,
      taskType: normaliseTaskType(parsed.taskType, input.mediaType),
      confidence: clamp(parsed.confidence),
      clarificationQuestion: parsed.clarificationQuestion?.trim() || null,
      usage,
    };
  }

  // --- internals ------------------------------------------------------------

  private async analyse(
    content: Content[],
    schema: unknown,
    name: string,
  ): Promise<AssetAnalysis> {
    const { parsed, usage } = await this.call<{
      summary: string;
      extractedText: string | null;
      structured: Record<string, unknown>;
      facts: AssetAnalysis['facts'];
      // Images need the most room of the three: a photograph yields a long
      // structured description and a dozen facts, and gpt-5 bills its
      // reasoning against the same budget. Measured: 4,000 was enough for a
      // document every time and for a 1024x1024 photograph only sometimes.
    }>(content, schema, name, 8_000);

    if (!parsed.summary || parsed.summary.trim().length === 0) {
      throw new BrainFailed('INVALID_RESPONSE', 'transient', 'The analysis came back empty.');
    }

    return {
      summary: parsed.summary.trim(),
      extractedText: parsed.extractedText?.trim() || null,
      structured: parsed.structured ?? {},
      facts: (parsed.facts ?? []).filter(
        (fact) => fact.attribute?.trim() && fact.value?.trim() && !recordsAnAbsence(fact.value),
      ),
      usage,
    };
  }

  private async call<T>(
    content: Content[],
    schema: unknown,
    schemaName: string,
    maxTokens: number,
  ): Promise<{ parsed: T; usage: BrainUsage }> {
    if (!this.apiKey) {
      throw new BrainFailed('NOT_CONFIGURED', 'permanent', 'The Brain is not configured.');
    }

    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          // The key goes in a header and nowhere else. Never logged, never in
          // a URL where it would reach an access log.
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content }],
          response_format: {
            type: 'json_schema',
            json_schema: { name: schemaName, strict: true, schema },
          },
          max_completion_tokens: maxTokens,
          // Reasoning tokens are billed against the budget above. This is
          // extraction, not deduction, so the cheapest setting is the right one
          // and leaves the budget for the answer.
          ...(this.model.startsWith('gpt-5') ? { reasoning_effort: 'low' } : {}),
        }),
        signal: AbortSignal.timeout(BRAIN_LIMITS.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new BrainFailed(
        timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR',
        'transient',
        timedOut ? 'The Brain timed out.' : 'The Brain could not be reached.',
      );
    }

    if (!response.ok) throw await classify(response);

    const body = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;

    const text = body?.choices?.[0]?.message?.content;
    if (!text) {
      // The model says which of these it was, so there is no need to guess.
      // "length" means the budget went on reasoning before any answer was
      // written — a real outcome for a dense image, and one an operator can
      // act on, unlike a flat "nothing usable".
      const ranOut = body?.choices?.[0]?.finish_reason === 'length';
      throw new BrainFailed(
        'INVALID_RESPONSE',
        'transient',
        ranOut
          ? 'The analysis ran out of token budget before it produced an answer.'
          : 'The Brain returned nothing usable.',
      );
    }

    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      // Never include the text: it contains the customer's content.
      throw new BrainFailed('INVALID_RESPONSE', 'transient', 'The Brain returned malformed output.');
    }

    return {
      parsed,
      usage: {
        inputTokens: body?.usage?.prompt_tokens ?? null,
        outputTokens: body?.usage?.completion_tokens ?? null,
        durationMs: Date.now() - started,
      },
    };
  }
}

/**
 * Whether a value says nothing is there.
 *
 * Asked to describe an asset, a model will conscientiously fill in every field
 * it was given — producing "tone: not specified" and "logo: none present" as
 * though they were observations. They are the opposite: they are the absence of
 * one, and counting them as evidence would build a Brand DNA out of things the
 * company does not do.
 *
 * The prompts already say not to. This is the guarantee, because an instruction
 * is not one.
 */
export function recordsAnAbsence(value: string): boolean {
  const normalised = value.trim().toLowerCase().replace(/^["'\s]+/, '');
  if (normalised.length === 0) return true;

  // Opens by saying there is nothing: "none", "n/a", "not specified", and the
  // rest of the ways a model declines a field it was obliged to fill in.
  if (/^(none|n\/a|nil|null|unknown|unspecified)/.test(normalised)) return true;
  if (/^not\s+(specified|stated|present|visible|available|discernible|identified|provided|listed|applicable)/.test(normalised)) {
    return true;
  }

  // "no logo present", "no specific words listed", "no explicit calls to action".
  if (/^no\s+[\w\s-]{1,40}(present|stated|specified|visible|found|provided|listed|given|available)/.test(normalised)) {
    return true;
  }

  return false;
}

function dataUri(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Reads the dimensions out of PNG or JPEG bytes.
 *
 * Only so a too-small image can be refused before it is sent. Returns null for
 * anything it does not recognise, and the caller treats an unknown size as
 * acceptable rather than guessing.
 */
export function pngOrJpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(1, 4).toString('ascii') === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      // SOF0..SOF15, excluding the markers that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }

  return null;
}

/**
 * Turns an error response into one of ours.
 *
 * Only the status and OpenAI's own error code shape the outcome. The message is
 * dropped: it can quote the content that was sent.
 */
async function classify(response: Response): Promise<BrainFailed> {
  let code: string | null = null;
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown; type?: unknown } };
    const value = body.error?.code ?? body.error?.type;
    code = typeof value === 'string' ? value : null;
  } catch {
    /* no body, or not JSON */
  }

  if (response.status === 429) {
    if (code === 'insufficient_quota') {
      // Waiting does not refill an empty account, so this is not a rate limit.
      return new BrainFailed('PROVIDER_ERROR', 'permanent', 'The Brain provider account is out of quota.');
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    return new BrainFailed(
      'RATE_LIMITED',
      'rate_limited',
      'The Brain provider is rate limiting us.',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new BrainFailed('NOT_CONFIGURED', 'permanent', 'The Brain provider rejected our credentials.');
  }
  if (response.status === 400 || response.status === 422) {
    return new BrainFailed('PROVIDER_ERROR', 'permanent', 'The Brain provider refused that request.');
  }
  if (response.status >= 500) {
    return new BrainFailed('PROVIDER_ERROR', 'transient', 'The Brain provider is having trouble.');
  }
  return new BrainFailed('PROVIDER_ERROR', 'transient', 'The Brain provider returned an error.');
}

export function openAIBrainFromEnv(): OpenAIBrainProvider {
  return new OpenAIBrainProvider(
    process.env.OPENAI_API_KEY,
    process.env.CIP_BRAIN_MODEL ?? DEFAULT_MODEL,
    process.env.OPENAI_BASE_URL ?? BASE_URL,
  );
}
