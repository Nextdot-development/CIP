import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fails the build if any company's data reached the browser bundle.
 *
 * The old prototype compiled every company into one JavaScript file that was
 * served to everyone. Nothing stops that returning by accident except a check
 * that looks — so this one runs in CI.
 */
const FORBIDDEN = [
  'Narayana Health',
  'Magic Moments',
  'Dr. Kavya Rao',
  'Ritika Sharma',
  'Patient Story Film',
  '@magicmoments.test',
  '@narayanahealth.test',
  'DATABASE_URL',
  'SESSION_SECRET',
];

const ROOT = join(process.cwd(), '.next', 'static');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

let failures = 0;
let scanned = 0;

for (const file of walk(ROOT)) {
  if (!/\.(js|css|json)$/.test(file)) continue;
  scanned += 1;
  const body = readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN) {
    if (body.includes(needle)) {
      console.error(`  LEAK  ${needle}  ->  ${file.replace(process.cwd(), '.')}`);
      failures += 1;
    }
  }
}

console.log(`Scanned ${scanned} client bundle files.`);
if (failures > 0) {
  console.error(`\n${failures} leak(s) found. Company data must not ship to the browser.`);
  process.exit(1);
}
console.log('No company data or secrets in the client bundle.');
