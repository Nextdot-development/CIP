import 'server-only';
import { FakeImageProvider } from './fake-image';
import { FakeVideoProvider } from './fake-video';
import { googleImageProviderFromEnv } from './google-image';
import { seedanceProviderFromEnv } from './seedance-video';
import type { ImageGenerationProvider, VideoGenerationProvider } from './types';

/**
 * Which provider answers.
 *
 * A real key selects the real provider; without one the deterministic fake
 * stands in, which is what the whole offline test suite runs against. There is
 * no third state where a real provider is selected and quietly returns
 * pretend results — an unconfigured real provider refuses, and the API reports
 * that it is unconfigured.
 *
 * CIP_FORCE_FAKE_PROVIDERS pins the fakes even when keys are present, so a test
 * run on a developer machine that happens to have credentials still costs
 * nothing and stays deterministic.
 */

let imageProvider: ImageGenerationProvider | null = null;
let videoProvider: VideoGenerationProvider | null = null;

function forceFake(): boolean {
  return process.env.CIP_FORCE_FAKE_PROVIDERS === 'true';
}

export function imageGenerationProvider(): ImageGenerationProvider {
  if (imageProvider) return imageProvider;

  if (!forceFake()) {
    const google = googleImageProviderFromEnv();
    if (google.configured) {
      imageProvider = google;
      return imageProvider;
    }
  }

  imageProvider = new FakeImageProvider();
  return imageProvider;
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

/**
 * What /api/health and the UI report.
 *
 * `configured` is about credentials, not about whether the fake works. A fake
 * that is standing in reports the real provider as unconfigured, so nobody
 * reads a green light and concludes Google is wired up.
 */
export function providerStatus(): {
  image: { provider: string; model: string; configured: boolean };
  video: { provider: string; model: string; configured: boolean; supportsCancel: boolean };
} {
  const image = imageGenerationProvider();
  const video = videoGenerationProvider();
  return {
    image: {
      provider: image.name,
      model: image.model,
      configured: image.name !== 'fake-image',
    },
    video: {
      provider: video.name,
      model: video.model,
      configured: video.name !== 'fake-video',
      supportsCancel: video.supportsCancel,
    },
  };
}

/** Tests swap in their own. */
export function __setProviders(
  image: ImageGenerationProvider | null,
  video: VideoGenerationProvider | null,
): void {
  imageProvider = image;
  videoProvider = video;
}

export { FakeImageProvider, FakeVideoProvider };
export * from './types';
