'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, EmptyState, Pill } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/context/toast';
import { relativeDay } from '@/lib/format';
import { IMAGE_PROVIDER_LABELS, assetUrl, isInFlight } from '@/types/media';
import type {
  ImageProviderChoice,
  MediaGenerationDTO,
  MediaType,
  ProviderStatusDTO,
} from '@/types/media';
import type { DriveFileDTO } from '@/types/drive';

/**
 * Media — asking a provider for an image or a video.
 *
 * Images come back with the response. Videos do not: the request only queues
 * one, so this polls until the worker reports it finished. That difference is
 * the provider's, not a choice made here, and the UI shows it honestly rather
 * than spinning as if a video were about to appear any second.
 *
 * Nothing here filters by company. It cannot see another company's work
 * because the endpoints only ever answer for the session's own.
 */

const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
/**
 * Runway names video shapes in pixels rather than as "720p", and refuses
 * anything else, so these are its own values with a readable label.
 */
const VIDEO_RATIOS: { value: string; label: string }[] = [
  { value: '1280:720', label: 'Landscape (1280x720)' },
  { value: '720:1280', label: 'Portrait (720x1280)' },
  { value: '960:960', label: 'Square (960x960)' },
  { value: '1920:1080', label: 'Landscape HD (1920x1080)' },
  { value: '1080:1920', label: 'Portrait HD (1080x1920)' },
];

export function MediaSection({
  initial,
  providers,
  referenceOptions,
}: {
  initial: MediaGenerationDTO[];
  providers: ProviderStatusDTO;
  referenceOptions: DriveFileDTO[];
}) {
  const { note } = useToast();
  const [tab, setTab] = useState<MediaType>('image');
  const [generations, setGenerations] = useState(initial);
  const [busy, setBusy] = useState(false);

  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [resolution, setResolution] = useState('1280:720');
  const [imageProvider, setImageProvider] = useState<ImageProviderChoice>(
    providers.defaultImageProvider,
  );
  const [referenceId, setReferenceId] = useState('');

  // Whichever generation the person is looking at now.
  const [focus, setFocus] = useState<string | null>(null);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/media/generations?limit=50', { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { generations: MediaGenerationDTO[] };
    setGenerations(data.generations);
  }, []);

  // A queued video finishes minutes later, so the list keeps asking. The
  // interval stops the moment nothing is in flight, so an idle tab is quiet.
  useEffect(() => {
    const waiting = generations.some((g) => isInFlight(g.status));
    if (!waiting) {
      if (polling.current) {
        clearInterval(polling.current);
        polling.current = null;
      }
      return;
    }
    if (polling.current) return;
    polling.current = setInterval(() => void refresh(), 4000);
    return () => {
      if (polling.current) {
        clearInterval(polling.current);
        polling.current = null;
      }
    };
  }, [generations, refresh]);

  const selectedImage = providers.images.find((p) => p.choice === imageProvider);
  const configured = tab === 'image' ? (selectedImage?.configured ?? false) : providers.video.configured;

  const submit = useCallback(async () => {
    const text = prompt.trim();
    if (text.length === 0) {
      note('Describe what you want first.');
      return;
    }

    setBusy(true);
    try {
      const endpoint = tab === 'image' ? '/api/media/images/generate' : '/api/media/videos/generate';
      const body =
        tab === 'image'
          ? { prompt: text, provider: imageProvider, aspectRatio, referenceFileIds: referenceId ? [referenceId] : [] }
          : { prompt: text, resolution, referenceFileId: referenceId || null };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        note('That is a lot of generating. Give it a moment.');
        return;
      }
      if (res.status === 503) {
        note('That provider is not configured yet.');
        return;
      }
      if (!res.ok) {
        const problem = (await res.json().catch(() => null)) as { message?: string } | null;
        note(problem?.message ?? 'That did not work. Try again in a moment.');
        return;
      }

      const data = (await res.json()) as { generation: MediaGenerationDTO };
      setFocus(data.generation.id);
      setPrompt('');
      await refresh();
      note(tab === 'image' ? 'Image ready.' : 'Video queued. It will appear here when it is done.');
    } finally {
      setBusy(false);
    }
  }, [aspectRatio, imageProvider, note, prompt, referenceId, refresh, resolution, tab]);

  const act = useCallback(
    async (id: string, action: 'retry' | 'cancel') => {
      const res = await fetch(`/api/media/generations/${id}/${action}`, { method: 'POST' });
      if (res.status === 429) {
        note('That is a lot of generating. Give it a moment.');
        return;
      }
      if (!res.ok) {
        const problem = (await res.json().catch(() => null)) as { message?: string } | null;
        note(problem?.message ?? 'That did not work.');
        return;
      }
      await refresh();
    },
    [note, refresh],
  );

  const shown = generations.filter((g) => g.type === tab);
  const focused = generations.find((g) => g.id === focus) ?? null;

  return (
    <>
      <div className="kind-filters">
        <button
          type="button"
          className={`kind-chip ${tab === 'image' ? 'on' : ''}`}
          onClick={() => { setTab('image'); setFocus(null); }}
        >
          <Icon name="image" size={14} /> Image
        </button>
        <button
          type="button"
          className={`kind-chip ${tab === 'video' ? 'on' : ''}`}
          onClick={() => { setTab('video'); setFocus(null); }}
        >
          <Icon name="video" size={14} /> Video
        </button>
      </div>

      {!configured && (
        <div className="notice">
          <Icon name="alert" size={15} />
          <span>
            <b className="strong">
              {tab === 'image' ? IMAGE_PROVIDER_LABELS[imageProvider] : 'Video generation'} is not
              configured.
            </b>{' '}
            No key is set for it, so nothing real can be generated with it yet.
            {tab === 'image' && providers.images.some((p) => p.configured) && ' Pick another provider above.'}
          </span>
        </div>
      )}

      <Card title={tab === 'image' ? 'Make an image' : 'Make a video'}>
        <label className="field">
          <span className="field-label">What should it show?</span>
          <textarea
            className="field-input"
            rows={3}
            value={prompt}
            maxLength={4000}
            placeholder={
              tab === 'image'
                ? 'A brass diya on dark marble, warm light, shallow depth of field'
                : 'A paper lantern drifting up over still water at dusk'
            }
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <div className="gen-options">
          {tab === 'image' && (
            <label className="field">
              <span className="field-label">Made by</span>
              <select
                className="field-input"
                value={imageProvider}
                onChange={(e) => setImageProvider(e.target.value as ImageProviderChoice)}
              >
                {providers.images.map((p) => (
                  <option key={p.choice} value={p.choice}>
                    {IMAGE_PROVIDER_LABELS[p.choice]}
                    {p.configured ? '' : ' — not configured'}
                  </option>
                ))}
              </select>
            </label>
          )}

          {tab === 'image' ? (
            <label className="field">
              <span className="field-label">Shape</span>
              <select className="field-input" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                {IMAGE_RATIOS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span className="field-label">Shape</span>
              <select className="field-input" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                {VIDEO_RATIOS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span className="field-label">Start from an image (optional)</span>
            <select className="field-input" value={referenceId} onChange={(e) => setReferenceId(e.target.value)}>
              <option value="">Nothing — start from the words</option>
              {referenceOptions.map((file) => (
                <option key={file.id} value={file.id}>{file.name}</option>
              ))}
            </select>
          </label>
        </div>

        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Working...' : tab === 'image' ? 'Generate image' : 'Queue video'}
        </button>
      </Card>

      {focused && focused.type === tab && (
        <Card title="Latest">
          <GenerationView generation={focused} onAct={act} supportsCancel={providers.video.supportsCancel} />
        </Card>
      )}

      <Card title="Everything you have made">
        {shown.length === 0 ? (
          <EmptyState
            icon={tab === 'image' ? 'image' : 'video'}
            title={`No ${tab}s yet`}
            copy="Describe what you want above and it will show up here."
          />
        ) : (
          shown.map((generation) => (
            <div className="gen-row" key={generation.id}>
              <button type="button" className="gen-thumb" onClick={() => setFocus(generation.id)}>
                {generation.status === 'completed' && generation.type === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetUrl(generation.id)} alt="" />
                ) : (
                  <Icon name={generation.type === 'image' ? 'image' : 'video'} size={18} />
                )}
              </button>

              <span className="stack grow">
                <span className="gen-prompt">{generation.prompt}</span>
                <span className="small muted">
                  {generation.provider} · {generation.model} · {relativeDay(generation.createdAt)}
                </span>
              </span>

              <Pill tone={toneFor(generation.status)}>{labelFor(generation)}</Pill>
            </div>
          ))
        )}
      </Card>
    </>
  );
}

function GenerationView({
  generation,
  onAct,
  supportsCancel,
}: {
  generation: MediaGenerationDTO;
  onAct: (id: string, action: 'retry' | 'cancel') => Promise<void>;
  supportsCancel: boolean;
}) {
  return (
    <div className="stack">
      <div className="row-between">
        <Pill tone={toneFor(generation.status)}>{labelFor(generation)}</Pill>
        <span className="small muted">{generation.provider} · {generation.model}</span>
      </div>

      {generation.status === 'completed' && (
        generation.type === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="gen-preview" src={assetUrl(generation.id)} alt={generation.prompt} />
        ) : (
          <video className="gen-preview" src={assetUrl(generation.id)} controls playsInline />
        )
      )}

      {isInFlight(generation.status) && (
        <p className="small muted">
          {generation.status === 'queued'
            ? 'Waiting for a slot. This page will update on its own.'
            : 'Being made now. Videos usually take a few minutes.'}
        </p>
      )}

      {generation.errorMessage && (
        <p className="small" style={{ color: 'var(--danger)' }}>{generation.errorMessage}</p>
      )}

      <div className="row-gap">
        {(generation.status === 'failed' || generation.status === 'cancelled') && (
          <button type="button" className="btn btn-sm" onClick={() => void onAct(generation.id, 'retry')}>
            Try again
          </button>
        )}
        {isInFlight(generation.status) && (generation.type === 'image' || supportsCancel) && (
          <button type="button" className="btn btn-sm" onClick={() => void onAct(generation.id, 'cancel')}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function toneFor(status: MediaGenerationDTO['status']): 'ok' | 'warn' | 'stop' | 'neutral' {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'stop';
  if (status === 'cancelled') return 'neutral';
  return 'warn';
}

function labelFor(generation: MediaGenerationDTO): string {
  switch (generation.status) {
    case 'completed':
      return 'Ready';
    case 'failed':
      return 'Did not work';
    case 'cancelled':
      return 'Cancelled';
    case 'processing':
      return 'Making it';
    default:
      return 'Queued';
  }
}
