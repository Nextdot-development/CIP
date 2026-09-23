import 'server-only';
import { createHash } from 'node:crypto';
import { BrainFailed } from './types';
import type {
  AssetAnalysis,
  AssetFact,
  BrainProvider,
  BriefInput,
  AssetKind,
  CheckAnalysis,
  CreativeContext,
  IdentifyInput,
  CheckFinding,
  CheckInput,
  ChatAnswer,
  ChatInput,
  ConceptDraft,
  CreativeFormat,
  IdeationInput,
  IdeationResult,
  TranscribeInput,
  Transcription,
  DocumentInput,
  MarketDocumentInput,
  MarketReading,
  MarketSignalDraft,
  FeedbackAnalysis,
  FeedbackInput,
  FramesInput,
  GenerationBrief,
  ImageInput,
  PdfPageAnalysis,
  PdfPageInput,
} from './types';

/**
 * A deterministic Brain for tests.
 *
 * Everything it returns is derived from its input, so the same asset always
 * produces the same analysis and two different assets never produce the same
 * one. That is what lets tests assert on real behaviour — that understanding
 * was stored, that a lesson was scoped correctly, that a brief carried the
 * retrieved memory through — without a key, a bill or a network.
 *
 * It is never selected by accident: the registry picks it only when explicitly
 * forced. An unconfigured real provider refuses rather than falling back here,
 * because a system quietly inventing brand knowledge is worse than one that
 * says it is not set up.
 */
export class FakeBrainProvider implements BrainProvider {
  readonly name = 'fake' as const;
  readonly model = 'fake-brain-1';
  readonly configured = true;

  /** Set by tests to exercise a failure path. */
  failWith: BrainFailed | null = null;
  /** Counts calls, so idempotency can be proved rather than assumed. */
  calls = { image: 0, frames: 0, document: 0, pdfPage: 0, feedback: 0, brief: 0, check: 0, identify: 0, market: 0, chat: 0, ideas: 0, ocr: 0 };

  /**
   * What the next checks report. Null means a clean pass.
   *
   * Set by tests, which is the point: the checker's own logic - discarding a
   * finding that cites a rule nobody sent, working the score out from the
   * findings, capping an observed rule at a warning - is what is under test,
   * and it can only be tested against findings chosen on purpose.
   */
  checkFindings: CheckFinding[] | null = null;
  /** What the page is, when a test needs it to be something else. */
  checkAssetKind: AssetKind | null = null;
  /** The last check's input, so a test can see what the Brain was given. */
  lastCheckInput: CheckInput | null = null;

  /**
   * What the next market readings report. Null means: every sentence in the
   * text carrying a percentage becomes a share signal quoting itself.
   */
  marketSignals: MarketSignalDraft[] | null = null;

  /** What the next answer says. Null means: cite the first three sources. */
  chatAnswer: Partial<Omit<ChatAnswer, 'usage'>> | null = null;

  /** The last question's input, so a test can see what the Brain was given. */
  lastChatInput: ChatInput | null = null;

  /** What the next concepts are. Null means: one concept per source, in order. */
  ideaConcepts: ConceptDraft[] | null = null;

  lastIdeationInput: IdeationInput | null = null;

  /** What each page reads as, by page number. Null means each page says which page it is. */
  ocrPages: string[] | null = null;

  /**
   * What the next images report as facts. Null means: derived from the bytes.
   *
   * Set when a test needs two *different* assets to agree with each other.
   * Uploading the same bytes twice used to do that, and does not any more:
   * one content is read once, because two copies of a deck are one asset with
   * two names and counting them as two inflates the evidence behind a claim.
   */
  imageFacts: AssetFact[] | null = null;

  reset(): void {
    this.ocrPages = null;
    this.imageFacts = null;
    this.ideaConcepts = null;
    this.lastIdeationInput = null;
    this.failWith = null;
    this.checkFindings = null;
    this.checkAssetKind = null;
    this.lastCheckInput = null;
    this.identified = null;
    this.marketSignals = null;
    this.chatAnswer = null;
    this.lastChatInput = null;
    this.calls = { image: 0, frames: 0, document: 0, pdfPage: 0, feedback: 0, brief: 0, check: 0, identify: 0, market: 0, chat: 0, ideas: 0, ocr: 0 };
  }

  private check(): void {
    if (this.failWith) throw this.failWith;
  }

  async analyzeImage(input: ImageInput): Promise<AssetAnalysis> {
    this.calls.image += 1;
    this.check();

    // Derived from the bytes, so a changed image genuinely changes the result.
    const digest = createHash('sha256').update(input.bytes).digest('hex');
    const colour = `#${digest.slice(0, 6)}`;
    const composition = pick(digest, 8, ['centred', 'rule-of-thirds', 'flat-lay', 'close-up']);
    const lighting = pick(digest, 10, ['soft daylight', 'warm candlelight', 'hard studio', 'moody low-key']);

    return {
      summary: `Image "${input.filename}" with a ${lighting} look and ${composition} composition.`,
      extractedText: null,
      structured: {
        objects: ['product'],
        products: [],
        brandElements: [],
        logoPresent: digest.charCodeAt(0) % 2 === 0,
        colours: [colour],
        typography: [],
        // Derived from the bytes like everything else here, so the same image
        // always lays out the same way and a test can assert on it.
        design: {
          logoPlacement: pick(digest, 12, ['top-left', 'top-right', 'bottom-centre', 'centred']),
          logoScale: pick(digest, 14, ['small', 'about a quarter', 'dominant']),
          productPlacement: pick(digest, 16, ['centred', 'right third', 'left third']),
          headlinePlacement: pick(digest, 18, ['upper third', 'lower third', 'centred']),
          headlineCase: pick(digest, 20, ['all caps', 'title case', 'sentence case']),
          fonts: [pick(digest, 22, ['geometric sans', 'high-contrast serif', 'script'])],
          paletteHex: [colour],
          safeArea: null,
        },
        composition,
        background: pick(digest, 12, ['plain', 'textured', 'gradient']),
        lighting,
        style: 'photographic',
        mood: pick(digest, 14, ['warm', 'calm', 'energetic']),
        contentType: 'brand asset',
      },
      facts: this.imageFacts
        ? this.imageFacts.map((fact) => ({ ...fact }))
        : [
            { section: 'visual', attribute: 'dominant_colour', value: colour },
            { section: 'visual', attribute: 'composition', value: composition },
            { section: 'visual', attribute: 'lighting', value: lighting },
          ],
      usage: { inputTokens: 10, outputTokens: 20, durationMs: 1 },
    };
  }

  async analyzeFrames(input: FramesInput): Promise<AssetAnalysis> {
    this.calls.frames += 1;
    this.check();

    const digest = createHash('sha256')
      .update(Buffer.concat(input.frames.map((f) => f.bytes)))
      .digest('hex');
    const pacing = pick(digest, 0, ['slow', 'measured', 'fast']);
    const shot = pick(digest, 4, ['wide', 'close-up', 'medium']);

    return {
      summary:
        `Video "${input.filename}", ${Math.round(input.durationSeconds)}s, ${pacing} pacing, ` +
        `mostly ${shot} shots across ${input.frames.length} sampled frames.`,
      extractedText: input.transcript,
      structured: {
        shotTypes: [shot],
        cameraMovement: [pick(digest, 6, ['static', 'slow push-in', 'handheld'])],
        pacing,
        transitions: ['cut'],
        textOverlays: [],
        products: [],
        brandElements: [],
        colours: [`#${digest.slice(0, 6)}`],
        style: 'cinematic',
        mood: 'warm',
        contentType: 'brand film',
        scenes: input.frames.map((f) => ({ atSeconds: f.atSeconds, describes: `frame at ${f.atSeconds}s` })),
      },
      facts: [
        { section: 'video', attribute: 'pacing', value: pacing },
        { section: 'video', attribute: 'shot_type', value: shot },
      ],
      usage: { inputTokens: 20, outputTokens: 30, durationMs: 1 },
    };
  }

  async analyzeDocument(input: DocumentInput): Promise<AssetAnalysis> {
    this.calls.document += 1;
    this.check();

    if (input.text.trim().length === 0) {
      throw new BrainFailed('UNSUPPORTED_ASSET', 'permanent', 'That document has no readable text.');
    }

    const digest = createHash('sha256').update(input.text).digest('hex');
    const tone = pick(digest, 0, ['warm and unhurried', 'direct', 'playful']);

    return {
      // The opening of the document, not only its name and a tone.
      //
      // A summary is what gets embedded, so a summary that keeps none of the
      // document's words leaves nothing for similarity to find: searching for
      // what a file plainly says returned it on any machine with an API key
      // and never on CI, where both the Brain and the embedder are these
      // fakes. A stand-in that drops the property under test is not standing
      // in for anything.
      summary: `Document "${input.filename}" written in a ${tone} tone. ${opening(input.text)}`,
      extractedText: input.text.slice(0, 400),
      structured: {
        objects: [], products: [], brandElements: [], logoPresent: false,
        colours: [], typography: [], composition: '', background: '',
        lighting: '', style: 'written', mood: tone, contentType: 'brand document',
      },
      facts: [{ section: 'content', attribute: 'tone', value: tone }],
      usage: { inputTokens: 15, outputTokens: 15, durationMs: 1 },
    };
  }

  /**
   * A page of posts, derived from the rendered bytes.
   *
   * How many posts it finds comes from the image itself, so a test can assert
   * that segmentation reached the database without the number being written
   * into the test twice. A page whose digest says "cover" yields none, which
   * is what keeps the empty-page path exercised.
   */
  async analyzePdfPage(input: PdfPageInput): Promise<PdfPageAnalysis> {
    this.calls.pdfPage += 1;
    this.check();

    const digest = createHash('sha256').update(input.bytes).digest('hex');
    const colour = `#${digest.slice(0, 6)}`;
    const designStyle = pick(digest, 6, ['minimal', 'bold-typographic', 'photographic', 'collage']);
    const country = pick(digest, 16, ['India', 'United Arab Emirates', 'Nepal']);

    // 0 to 3, from the bytes and the page number together. Both matter: the
    // bytes so a different picture gives a different answer, and the page so a
    // document built from two repeated images still exercises pages with posts
    // and pages without. Zero stands for a cover or divider page.
    const count = (parseInt(digest.slice(20, 21), 16) + input.pageNumber) % 4;

    const posts = Array.from({ length: count }, (_, index) => {
      const seed = digest.slice(index * 4, index * 4 + 8);
      return {
        postIndex: index,
        country,
        account: '@magicmoments',
        postedOn: null,
        caption: `Caption ${seed.slice(0, 4)} on page ${input.pageNumber}`,
        headline: null,
        visibleText: `Post ${index} text ${seed}`,
        summary: `A ${designStyle} post from ${country} on page ${input.pageNumber}.`,
        product: null,
        location: null,
        eventContext: pick(seed, 0, ['Diwali', 'New Year', 'Holi']),
        cta: pick(seed, 2, ['Shop now', 'Tag a friend', 'Learn more']),
        hashtags: [`#${seed.slice(0, 5)}`],
        offer: null,
        creativeFormat: pick(seed, 4, ['single image', 'carousel', 'reel cover']),
        photographyStyle: pick(seed, 6, ['studio', 'lifestyle', 'candid']),
        designStyle,
        composition: pick(seed, 1, ['centred', 'rule-of-thirds']),
        colours: [colour],
        typography: ['sans-serif'],
        logoVisible: seed.charCodeAt(0) % 2 === 0,
        people: null,
        confidence: 0.9,
      };
    });

    return {
      summary:
        `Page ${input.pageNumber} of ${input.pageCount} of "${input.filename}": ` +
        `${count} post(s), ${designStyle} styling.`,
      extractedText: input.pageText ?? posts.map((post) => post.visibleText).join(' '),
      structured: {
        pageKind: count === 0 ? 'cover' : 'post grid',
        postCount: count,
        country,
        account: '@magicmoments',
        colours: [colour],
        typography: ['sans-serif'],
        designStyle,
        recurringPatterns: [`${designStyle} layout`],
      },
      facts: [
        { section: 'visual', attribute: 'design_style', value: designStyle },
        { section: 'visual', attribute: 'dominant_colour', value: colour },
      ],
      posts,
      usage: { inputTokens: 12, outputTokens: 24, durationMs: 1 },
    };
  }

  async analyzeFeedback(input: FeedbackInput): Promise<FeedbackAnalysis> {
    this.calls.feedback += 1;
    this.check();

    // A bare score teaches nothing. Only a comment produces a lesson, which is
    // the behaviour the real provider is instructed towards too.
    const comment = input.comment?.trim();
    if (!comment) return { lessons: [], usage: { durationMs: 1 } };

    // Scoped as narrowly as the context allows, so a campaign-specific remark
    // never becomes a company-wide rule.
    const appliesTo = input.campaign ? 'campaign' : input.product ? 'product' : 'task_type';

    return {
      lessons: [
        {
          polarity: input.score >= 6 ? 'prefer' : 'avoid',
          statement: comment.slice(0, 200),
          appliesTo,
          confidence: input.score >= 8 || input.score <= 2 ? 0.8 : 0.5,
        },
      ],
      usage: { durationMs: 1 },
    };
  }

  async buildGenerationBrief(input: BriefInput): Promise<GenerationBrief & { usage: { durationMs: number } }> {
    this.calls.brief += 1;
    this.check();

    // Ask only when the request genuinely does not pin down which of several
    // campaigns is meant — the same condition the real provider is given.
    const mentionsCampaign = input.knownCampaigns.some((c) =>
      input.requestText.toLowerCase().includes(c.toLowerCase()),
    );
    const needsClarification = input.knownCampaigns.length > 1 && !mentionsCampaign;

    const brandRules = input.brandFacts.map((f) => `${f.attribute}: ${f.value}`);
    const preferred = input.lessons.filter((l) => l.polarity === 'prefer').map((l) => l.statement);
    const avoided = input.lessons.filter((l) => l.polarity === 'avoid').map((l) => l.statement);

    // The retrieved memory is carried into the prompt, so a test can prove the
    // generator received brand context rather than the raw request.
    const promptParts = [input.requestText, ...brandRules, ...preferred];

    return {
      // The planner decides these and overwrites them; a provider is never
      // asked which brand or market a request is for.
      brand: null,
      market: null,
      taskType: input.mediaType === 'video' ? 'promotional_video' : 'promotional_image',
      // Read off the words, deterministically, the way the rest of this double
      // works: the tests need a format that follows the request rather than a
      // constant, so they can assert the shape actually travels.
      format: formatFromWords(input.requestText),
      platform: input.requestText.toLowerCase().includes('instagram') ? 'instagram' : null,
      campaign: input.knownCampaigns.find((c) => input.requestText.toLowerCase().includes(c.toLowerCase())) ?? null,
      product: input.knownProducts.find((p) => input.requestText.toLowerCase().includes(p.toLowerCase())) ?? null,
      visualDirection: input.mediaType === 'image' ? brandRules.join('; ') || null : null,
      videoDirection: input.mediaType === 'video' ? brandRules.join('; ') || null : null,
      contentDirection: null,
      brandRules,
      successfulPatterns: input.successfulExamples.map((e) => e.requestText),
      negativePatterns: input.negativeExamples.map((e) => e.requestText),
      learnedPreferences: preferred,
      constraints: [],
      avoid: avoided,
      generationPrompt: promptParts.join('. '),
      confidence: needsClarification ? 0.2 : input.brandFacts.length > 0 ? 0.8 : 0.45,
      clarificationQuestion: needsClarification
        ? `Which campaign is this for: ${input.knownCampaigns.join(', ')}?`
        : null,
      usage: { durationMs: 1 },
    };
  }

  /** What the next identification says. Null means: it could not tell. */
  identified: Partial<Omit<CreativeContext, 'usage'>> | null = null;

  async identifyCreative(_input: IdentifyInput): Promise<CreativeContext> {
    this.calls.identify += 1;
    this.check();

    // Null unless a test says otherwise, which is the honest default: a fake
    // that guessed a brand would hide the fact that a guess pulls in the wrong
    // rules.
    return {
      brand: this.identified?.brand ?? null,
      product: this.identified?.product ?? null,
      confidence: this.identified?.confidence ?? 0,
      evidence: this.identified?.evidence ?? null,
      usage: { durationMs: 1 },
    };
  }

  async checkCreative(input: CheckInput): Promise<CheckAnalysis> {
    this.calls.check += 1;
    this.check();
    this.lastCheckInput = input;

    // A creative unless a test says otherwise: almost every test is about what
    // happens to a creative, and making each one say so would be noise.
    // The same rule the real provider follows: only a page of a document may
    // say it is not a creative.
    const assetKind = input.fromDocument ? (this.checkAssetKind ?? 'creative') : 'creative';

    return {
      assetKind,
      summary: `Checked "${input.filename}" against ${input.rules.length} rule(s).`,
      findings:
        assetKind === 'creative' && this.checkFindings
          ? this.checkFindings.map((f) => ({ ...f }))
          : [],
      usage: { durationMs: 1 },
    };
  }

  async readMarketDocument(input: MarketDocumentInput): Promise<MarketReading> {
    this.calls.market += 1;
    this.check();

    const signals: MarketSignalDraft[] = this.marketSignals
      ? this.marketSignals.map((s) => ({ ...s }))
      : input.text
          .split(/(?<=[.!?])\s+/)
          .filter((sentence) => /\d+(?:\.\d+)?%/.test(sentence))
          .slice(0, 20)
          .map((sentence) => {
            const trimmed = sentence.trim();
            const own = input.brands.find((b) => trimmed.toLowerCase().includes(b.name.toLowerCase()));
            return {
              kind: 'share' as const,
              subject: own?.name ?? trimmed.split(/\s+/).slice(0, 2).join(' '),
              subjectType: own ? ('own_brand' as const) : ('competitor' as const),
              market: input.markets.find((m) => trimmed.includes(m)) ?? null,
              category: null,
              metric: 'share',
              value: Number(/(\d+(?:\.\d+)?)%/.exec(trimmed)![1]),
              unit: '%',
              period: null,
              statement: trimmed,
              excerpt: trimmed,
            };
          });

    return {
      summary: `Part ${input.part} of ${input.parts} of "${input.filename}".`,
      signals,
      usage: { durationMs: 1 },
    };
  }

  async answerQuestion(input: ChatInput): Promise<ChatAnswer> {
    this.calls.chat += 1;
    this.check();
    this.lastChatInput = { ...input, sources: input.sources.map((s) => ({ ...s })) };

    if (this.chatAnswer) {
      return {
        answer: this.chatAnswer.answer ?? '',
        citations: [...(this.chatAnswer.citations ?? [])],
        followUps: [...(this.chatAnswer.followUps ?? [])],
        usage: { durationMs: 1 },
      };
    }

    const used = input.sources.slice(0, 3);
    return {
      answer: used.length
        ? used.map((s) => `${s.text} [${s.ref}]`).join(' ')
        : 'CIP has nothing stored that answers this yet.',
      citations: used.map((s) => s.ref),
      followUps: ['What else do we know about this?'],
      usage: { durationMs: 1 },
    };
  }

  async ideateConcepts(input: IdeationInput): Promise<IdeationResult> {
    this.calls.ideas += 1;
    this.check();
    this.lastIdeationInput = { ...input, sources: input.sources.map((s) => ({ ...s })) };

    const concepts: ConceptDraft[] = this.ideaConcepts
      ? this.ideaConcepts.map((c) => ({ ...c, groundedIn: [...c.groundedIn] }))
      : input.sources.slice(0, input.count).map((source, i) => ({
          title: `Concept ${i + 1}`,
          pitch: `Built on ${source.text}.`,
          format: 'Social',
          groundedIn: [source.ref],
        }));
    return { concepts, usage: { durationMs: 1 } };
  }

  async transcribePage(input: TranscribeInput): Promise<Transcription> {
    this.calls.ocr += 1;
    this.check();
    const text = this.ocrPages
      ? (this.ocrPages[input.pageNumber - 1] ?? '')
      : `Page ${input.pageNumber} of ${input.filename}.`;
    // A tall page arrives in strips; its text comes back once, with the first.
    return { text: input.part === 1 ? text : '', usage: { durationMs: 1 } };
  }
}

/** Stable choice from a digest, so the same input always picks the same value. */
/**
 * The first words of a document, for its summary to carry.
 *
 * Trimmed to a sentence or so: enough that a search for what the document says
 * can find it, short enough that the summary still reads as a summary.
 */
function opening(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  const stop = flat.indexOf('. ');
  const first = stop > 0 ? flat.slice(0, stop + 1) : flat;
  return first.length > 200 ? `${first.slice(0, 200).trimEnd()}…` : first;
}

function pick(digest: string, offset: number, options: string[]): string {
  const value = parseInt(digest.slice(offset, offset + 2), 16);
  return options[value % options.length]!;
}

/** The shape a request names, matched on the words a person would use. */
function formatFromWords(requestText: string): CreativeFormat {
  const text = requestText.toLowerCase();
  if (text.includes('billboard') || text.includes('hoarding')) return 'billboard';
  if (text.includes('banner')) return 'banner';
  if (text.includes('story') || text.includes('reel')) return 'story';
  if (text.includes('carousel')) return 'carousel_card';
  if (text.includes('poster')) return 'poster';
  if (text.includes('thumbnail')) return 'thumbnail';
  if (text.includes('post')) return 'feed_post';
  return 'other';
}
