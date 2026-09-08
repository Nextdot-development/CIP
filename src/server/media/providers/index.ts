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
  const configured = process.env.CIP_DEFAULT_IMAGE_PROVIDER;
  if (configured && (IMAGE_PROVIDER_CHOICES as readonly string[]).includes(configured)) {
    return configured as ImageProviderChoice;
  }
  return 'gemini';
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

  // The preferred provider has no key. Use the other one if it has one, rather
  // than refusing work the deployment is plainly equipped to do.
  const other = defaultChoice() === 'gemini' ? 'openai' : 'gemini';
  const alternative = providerFor(other);
  if (alternative.configured) return alternative;

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

  const images = IMAGE_PROVIDER_CHOICES.map((choice) => {
    const provider = providerFor(choice);
    return {
      choice,
      provider: provider.name,
      model: provider.model,
      configured: provider.name !== 'fake-image' && provider.configured,
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
