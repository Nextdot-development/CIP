import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';

/**
 * What a file is for: brand material, market data, or a book kept for reference.
 *
 *   brand      read into Brand DNA - what this brand looks and sounds like
 *   market     read for market signals - shares, prices, moves
 *   reference  background reading - searchable, quoted in chat, and its craft
 *              given to the brief - but never either of the above
 *
 * A book read as brand material teaches Radico Coca-Cola's colours; read as
 * market data, it turned a toy company's Christmas advertising into a
 * competitor's move. So a book is recognised when it is read, and a person can
 * always say otherwise - and once they have, CIP does not change it back.
 */

export type KnowledgeRole = 'brand' | 'market' | 'reference';

const PUBLISHERS =
  /\b(penguin|wiley|mcgraw[- ]hill|pearson|prentice hall|harpercollins|harper ?business|random house|simon (&|and) schuster|o'?reilly|free press|crown business|rockport|hyphen press|basic books|new riders|princeton architectural|bloomsbury|macmillan|hachette|little, brown|portfolio|vintage books|thomas nelson|arthur niggli|crown publishing|ballantine)\b/i;
/** What a company's own long documents say about themselves. Books do not. */
const NOT_A_BOOK =
  /\b(annual report|red herring|prospectus|investor presentation|financial statements|balance sheet|board of directors|sebi|quarterly results|earnings call|global status report|world health organization)\b/gi;
/** The pages only a book has. */
const FRONT_MATTER =
  /\b(preface|foreword|acknowledge?ments|about the authors?|bibliography|vorwort|inhaltsverzeichnis|einleitung|epilogue|prologue)\b/gi;

/**
 * Whether a document is a book.
 *
 * Read from the marks a published book carries - an ISBN, a Library of
 * Congress line, a copyright page, chapters, a preface - and only when nothing
 * says it is a company's own report. Tested on Radico's 78 PDFs before it was
 * written down: all thirteen books, and none of the annual reports, the
 * prospectus or the WHO report, which has an ISBN of its own.
 */
export function looksLikeBook(input: { name: string; pageCount: number | null; text: string }): boolean {
  const pages = input.pageCount ?? 0;
  if (pages < 20) return false;
  // The opening, where the copyright page and the contents are, and the end,
  // where the index and the author's note are.
  const t = input.text.length > 36_000 ? `${input.text.slice(0, 30_000)} ${input.text.slice(-6_000)}` : input.text;
  if ((t.match(NOT_A_BOOK) ?? []).length >= 3) return false;

  const isbn = /\bISBN(?:-1[03])?[:\s]*[\d-]{10,}/i.test(t);
  const congress = /library of congress/i.test(t);
  const copyright = /copyright\s*(?:©|\(c\))?\s*(?:©\s*)?\d{4}|©\s*\d{4}/i.test(t);
  const rights = /all rights reserved/i.test(t);
  const chapters = (t.match(/\b(?:chapter|kapitel)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi) ?? []).length;
  const front = new Set((t.match(FRONT_MATTER) ?? []).map((w) => w.toLowerCase())).size;
  const publisher = PUBLISHERS.test(t);
  // Named the way only a downloaded book is.
  const libraryCopy = /\b(z-?lib|libgen|epub|ebook)\b/i.test(input.name);

  return (
    libraryCopy ||
    (pages >= 40 &&
      (isbn || congress ||
        (copyright && (rights || publisher) && (chapters >= 2 || publisher || front >= 1)) ||
        (publisher && chapters >= 3))) ||
    (pages >= 80 && front >= 2) ||
    (pages >= 100 && copyright && front >= 1)
  );
}

/** A file's role, and whether a person chose it. Null when it is not this company's. */
export async function getKnowledgeRole(
  scope: CompanyScope,
  fileId: string,
): Promise<{ role: KnowledgeRole; chosen: boolean } | null> {
  const rows = await withCompanyScope(scope, (tx) =>
    tx<{ knowledge_role: KnowledgeRole; knowledge_role_chosen: boolean }[]>`
      select knowledge_role, knowledge_role_chosen from drive_files
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
    `,
  ).catch(() => []);
  const row = rows[0];
  return row ? { role: row.knowledge_role, chosen: row.knowledge_role_chosen } : null;
}

/**
 * What a person says a file is for. It stays that way: CIP's own guess never
 * overrides it.
 *
 * Each role undoes what the others set going. A book is not read as brand
 * material or for market signals, and any signals it already gave are
 * retired; market data is registered to be read; brand material stops being
 * read for signals.
 */
export async function setKnowledgeRole(
  scope: CompanyScope,
  fileId: string,
  role: KnowledgeRole,
): Promise<boolean> {
  return withCompanyScope(scope, async (tx) => {
    const updated = await tx<{ id: string }[]>`
      update drive_files
         set knowledge_role = ${role}, knowledge_role_chosen = true, updated_at = now()
       where id = ${fileId} and company_id = ${scope.companyId} and archived_at is null
      returning id
    `;
    if (updated.length === 0) return false;
    await afterRoleChange(tx, scope.companyId, fileId, role);
    if (role === 'market') {
      await tx`
        insert into market_sources (company_id, file_id)
        values (${scope.companyId}, ${fileId})
        on conflict (company_id, file_id) do nothing
      `;
    }
    return true;
  });
}

type Tx = Parameters<Parameters<typeof withCompanyScope>[1]>[0];

/** What follows from a file's role changing, in the same transaction. */
export async function afterRoleChange(tx: Tx, companyId: string, fileId: string, role: KnowledgeRole): Promise<void> {
  if (role !== 'brand') {
    // Not brand material: nothing still waiting reads it into Brand DNA.
    await tx`
      delete from asset_understanding
       where company_id = ${companyId} and file_id = ${fileId} and status = 'pending'
    `;
  }
  if (role !== 'market') {
    // Not market data: what it was read to say about the market is retired.
    await tx`
      update market_signals set status = 'rejected', rejected_at = now()
       where company_id = ${companyId} and file_id = ${fileId} and status = 'active'
    `;
  }
}

/**
 * A book recognised as it is read. Only a role nobody chose is changed, so a
 * person who said "this is market data" is never second-guessed.
 */
export async function recogniseBook(
  tx: Tx,
  companyId: string,
  file: { id: string; name: string },
  extracted: { pageCount: number | null; text: string },
): Promise<boolean> {
  if (!looksLikeBook({ name: file.name, pageCount: extracted.pageCount, text: extracted.text })) return false;
  const changed = await tx<{ id: string }[]>`
    update drive_files set knowledge_role = 'reference', updated_at = now()
     where id = ${file.id} and company_id = ${companyId}
       and knowledge_role <> 'reference' and not knowledge_role_chosen
    returning id
  `;
  if (changed.length === 0) return false;
  await afterRoleChange(tx, companyId, file.id, 'reference');
  return true;
}
