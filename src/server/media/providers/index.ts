import 'server-only';
import { FakeImageProvider } from './fake-image';
import { FakeVideoProvider } from './fake-video';
import { googleImageProviderFromEnv } from './google-image';
import { openAIImageProviderFromEnv } from './openaiImage';
import { seedanceProviderFromEnv } from './seedance-video';
import { IMAGE_PROVIDER_CHOICES } from './types';
import type {
  ImageGenerationProvider,
  ImageProviderChoice,
  VideoGenerationProvider,
} from './types';

/**
 * Which provider answers.
 *
 * Two image providers now sit side by side — Gemini and OpenAI — and a caller
 * may name either. Naming one that has no key configured is refused rather
 * than quietly served by the other: asking for OpenAI and silently getting
 * Gemini would be a worse outcome than an honest error.
 *
 * With no name given, the default is Gemini when it is configured, which is
 * what the system did before OpenAI existed. CIP_DEFAULT_IMAGE_PROVIDER
 * changes that without a deploy, and if the preferred one has no key the other
 * is used rather than failing — a key that is present is better evidence of
 * intent than a default nobody has revisited.
 *
 * Without any key the deterministic fake stands in, which is what the offline
 * test suite runs against. There is no third state where a real provider is
 * selected and quietly returns pretend results: an unconfigured real provider
 * refuses, and the API reports it as unconfigured.
 *
 * CIP_FORCE_FAKE_PROVIDERS pins the fakes even when keys are present, so a
 * test run on a machine that happens to have credentials still costs nothing.
 */

let videoProvider: VideoGenerationProvider | null = null;

/** Test overrides, by choice. Null means "work it out from the environment". */
let overrides: Partial<Record<ImageProviderChoice, ImageGenerationProvider>> = {};
let fallbackImageOverride: ImageGenerationProvider | null = null;

function forceFake(): boolean {
  return process.env.CIP_FORCE_FAKE_PROVIDERS === 'true';
}

/**
 * The image generators this deployment is allowed to use, best first.
 *
 * Gemini makes shapes OpenAI does not, and CIP used to hand it those requests.
 * But the Gemini account's free tier allows zero image generations — Google's
 * own answer is `limit: 0` — so every 4:5, 9:16 and 16:9 request was handed to
 * a generator that could not run, and came back as "the image provider is rate
 * limiting us" however long anyone waited. A shape is better cut from one that
 * works than made exactly by one that does not.
 *
 * So OpenAI is the only generator unless a deployment says otherwise:
 * CIP_IMAGE_PROVIDERS="openai,gemini" brings Gemini back once somebody has
 * enabled billing on that account.
 */
export function allowedImageChoices(): ImageProviderChoice[] {
  const named = (process.env.CIP_IMAGE_PROVIDERS ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is ImageProviderChoice =>
      (IMAGE_PROVIDER_CHOICES as readonly string[]).includes(part),
    );
  return named.length > 0 ? named : ['openai'];
}

function build(choice: ImageProviderChoice): ImageGenerationProvider {
  return choice === 'openai' ? openAIImageProviderFromEnv() : googleImageProviderFromEnv();
}

/** The provider for one choice, whether or not it has credentials. */
function providerFor(choice: ImageProviderChoice): ImageGenerationProvider {
  const override = overrides[choice];
  if (override) return override;
  if (forceFake()) return fallbackImageOverride ?? new FakeImageProvider();
  return build(choice);
}

function defaultChoice(): ImageProviderChoice {
  const allowed = allowedImageChoices();
  const configured = process.env.CIP_DEFAULT_IMAGE_PROVIDER;
  if (configured && allowed.includes(configured as ImageProviderChoice)) {
    return configured as ImageProviderChoice;
  }
  return allowed[0]!;
}

/**
 * Picks a provider.
 *
 * `choice` comes from the request when the caller named one. It has already
 * been validated against IMAGE_PROVIDER_CHOICES, so an unknown name never
 * reaches here.
 */
export function imageGenerationProvider(choice?: ImageProviderChoice | null): ImageGenerationProvider {
  if (choice) return providerFor(choice);

  if (forceFake()) return fallbackImageOverride ?? new FakeImageProvider();

  const preferred = providerFor(defaultChoice());
  if (preferred.configured) return preferred;

  // The preferred provider has no key. Use another allowed one if it has one,
  // rather than refusing work the deployment is plainly equipped to do.
  for (const other of allowedImageChoices()) {
    if (other === defaultChoice()) continue;
    const alternative = providerFor(other);
    if (alternative.configured) return alternative;
  }

  return fallbackImageOverride ?? new FakeImageProvider();
}

export function videoGenerationProvider(): VideoGenerationProvider {
  if (videoProvider) return videoProvider;

  if (!forceFake()) {
    const seedance = seedanceProviderFromEnv();
    if (seedance.configured) {
      videoProvider = seedance;
      return videoProvider;
    }
  }

  videoProvider = new FakeVideoProvider();
  return videoProvider;
}

export type ImageProviderStatus = {
  choice: ImageProviderChoice;
  provider: string;
  model: string;
  configured: boolean;
  /**
   * The shapes this one makes itself.
   *
   * Reported so the page can say which sizes are made directly and which are
   * cut from a larger one, instead of offering five sizes as though every
   * generator made all of them. OpenAI makes three; Gemini makes ten.
   */
  aspectRatios: string[];
};

/**
 * What /api/health and the UI report.
 *
 * `configured` is about credentials, not about whether the fake works. A fake
 * standing in reports the real provider as unconfigured, so a deployment
 * quietly generating placeholder images is visible rather than plausible.
 */
export function providerStatus(): {
  image: { provider: string; model: string; configured: boolean };
  images: ImageProviderStatus[];
  defaultImageProvider: ImageProviderChoice;
  video: { provider: string; model: string; configured: boolean; supportsCancel: boolean };
} {
  const active = imageGenerationProvider();
  const video = videoGenerationProvider();

  // Only the generators this deployment will actually use. A picker that
  // offers one CIP would refuse is a picker that lies.
  const images = allowedImageChoices().map((choice) => {
    const provider = providerFor(choice);
    return {
      choice,
      provider: provider.name,
      model: provider.model,
      configured: provider.name !== 'fake-image' && provider.configured,
      aspectRatios: [...provider.aspectRatios],
    };
  });

  return {
    // Kept for callers that only care which provider would answer right now.
    image: {
      provider: active.name,
      model: active.model,
      configured: active.name !== 'fake-image' && active.configured,
    },
    images,
    defaultImageProvider: defaultChoice(),
    video: {
      provider: video.name,
      model: video.model,
      configured: video.name !== 'fake-video' && video.configured,
      supportsCancel: video.supportsCancel,
    },
  };
}

/**
 * Tests swap in their own.
 *
 * The image argument stands in for every choice, so an existing test that only
 * knows about one image provider keeps working. Pass `imagesByChoice` to give
 * each choice a different double, which is how provider selection is tested.
 */
export function __setProviders(
  image: ImageGenerationProvider | null,
  video: VideoGenerationProvider | null,
  imagesByChoice?: Partial<Record<ImageProviderChoice, ImageGenerationProvider>>,
): void {
  fallbackImageOverride = image;
  overrides = imagesByChoice
    ? { ...imagesByChoice }
    : image
      ? { openai: image, gemini: image }
      : {};
  videoProvider = video;
}

export { FakeImageProvider, FakeVideoProvider };
export * from './types';
