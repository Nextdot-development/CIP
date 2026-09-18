'use client';

import { useState } from 'react';
import { KnowledgeSection } from './KnowledgeSection';
import { DriveSection } from './DriveSection';
import { Icon } from '../components/ui/Icon';
import type { GoogleDriveConnectionDTO, SyncedFileDTO } from '@/types/integrations';
import type { DriveListingDTO } from '@/types/drive';

/**
 * Teach — the two ways knowledge gets into CIP.
 *
 * Connect a folder and it keeps itself current; upload files and it reads them
 * straight away. Both end in the same place, so they belong on the same page:
 * before this they were two separate destinations, and the one thing a person
 * comes here to do was split across them.
 *
 * What used to be on this page — a seeded "62% understood", a list of things
 * that percentage would unlock, questions to confirm, a voice and a palette —
 * was all demo data written by the seed and never updated by anything. None of
 * it moved when a file was uploaded. What CIP has actually learned is on
 * Trust, counted from the tables that hold it.
 */

type Tab = 'connect' | 'upload';

export function TeachSection({
  connection,
  syncedFiles,
  listing,
  googleOutcome,
}: {
  connection: GoogleDriveConnectionDTO;
  syncedFiles: SyncedFileDTO[];
  listing: DriveListingDTO;
  googleOutcome?: string;
}) {
  // A connected Drive is the thing most people set up once and leave alone, so
  // the upload tab opens first when one is already running.
  const [tab, setTab] = useState<Tab>(
    connection.status === 'connected' ? 'upload' : 'connect',
  );

  return (
    <div className="rise">
      <header className="page-head">
        <p className="eyebrow">Add data to brain</p>
        <h1>Give CIP something to learn from</h1>
        <p className="lede">
          Connect a Google Drive folder and it stays up to date on its own, or upload files here.
          Either way CIP reads them — documents, images, video and PDFs of posts — and learns what
          your brand looks and sounds like.
        </p>
      </header>

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'connect'}
          className={`tab ${tab === 'connect' ? 'active' : ''}`}
          onClick={() => setTab('connect')}
        >
          <Icon name="link" size={16} /> Connect a folder
          {connection.status === 'connected' && <span className="tab-dot" aria-hidden />}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'upload'}
          className={`tab ${tab === 'upload' ? 'active' : ''}`}
          onClick={() => setTab('upload')}
        >
          <Icon name="upload" size={16} /> Upload files
        </button>
      </div>

      {tab === 'connect' ? (
        <KnowledgeSection
          connection={connection}
          initialFiles={syncedFiles}
          outcome={googleOutcome}
          embedded
        />
      ) : (
        <DriveSection listing={listing} embedded />
      )}
    </div>
  );
}
