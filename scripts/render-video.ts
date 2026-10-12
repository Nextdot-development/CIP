import { renderApprovedEdits } from '../src/server/video/edit';

/**
 * Makes every approved film, here rather than on Vercel.
 *
 *   npm run video:render
 *
 * For a recording too long to make inside one five-minute pump pass: run it
 * on any machine with the project's environment, and it works through the
 * queue the pump would have.
 */
async function main(): Promise<void> {
  let made = 0;
  for (;;) {
    const n = await renderApprovedEdits({ outOfTime: () => false });
    if (n === 0) break;
    made += n;
    console.log(`  made ${made}`);
  }
  console.log(`\n  ${made} film(s) made.\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
