import postgres from 'postgres';
import { hashPassword } from '../src/server/auth/password';

/**
 * Changes how a person signs in: their password, and optionally their email.
 *
 *   CIP_NEW_PASSWORD='…' npm run set-login -- brand@radico.test
 *   CIP_NEW_PASSWORD='…' npm run set-login -- brand@radico.test --email team@example.com
 *
 * The password comes from the environment rather than the command line, so it
 * never lands in shell history or a process list, and it is never printed.
 *
 * Every session the person has is ended in the same transaction, so an old
 * password - or a laptop somebody left signed in - stops working everywhere at
 * once rather than whenever that session happens to expire.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {}, max: 1 });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const email = argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--email')?.trim().toLowerCase();
  const at = argv.indexOf('--email');
  const newEmail = at >= 0 ? argv[at + 1]?.trim().toLowerCase() : undefined;
  const password = process.env.CIP_NEW_PASSWORD ?? '';

  if (!email) {
    console.error("\n  CIP_NEW_PASSWORD='…' npm run set-login -- <current-email> [--email <new-email>]\n");
    process.exit(1);
  }
  if (password.length < 12) throw new Error('Set CIP_NEW_PASSWORD to a password of at least 12 characters.');
  if (password === 'cip-demo-password') throw new Error('That is the public demo password. Choose a real one.');
  if (newEmail !== undefined && !EMAIL.test(newEmail)) throw new Error(`"${newEmail}" is not an email address.`);

  const passwordHash = await hashPassword(password);

  const outcome = await admin.begin(async (tx) => {
    const users = await tx<{ id: string }[]>`
      update users set password_hash = ${passwordHash}
       where lower(email) = ${email}
      returning id
    `;
    const user = users[0];
    if (!user) return null;

    if (newEmail && newEmail !== email) {
      const taken = await tx<{ id: string }[]>`select id from users where lower(email) = ${newEmail} and id <> ${user.id}`;
      if (taken.length > 0) throw new Error(`${newEmail} already belongs to someone else.`);
      await tx`update users set email = ${newEmail} where id = ${user.id}`;
    }

    const ended = await tx<{ n: number }[]>`
      with gone as (delete from sessions where user_id = ${user.id} returning 1)
      select count(*)::int as n from gone
    `;
    return { sessions: ended[0]?.n ?? 0 };
  });

  if (!outcome) throw new Error(`Nobody signs in as ${email}.`);
  console.log(
    `\nUpdated the sign-in for ${newEmail ?? email}. ${outcome.sessions} existing session(s) were signed out.\n`,
  );
}

main()
  .then(async () => {
    await admin.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : 'failed');
    await admin.end({ timeout: 1 });
    process.exit(1);
  });
