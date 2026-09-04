'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { signIn } from '@/server/auth/signIn';
import { destroySession } from '@/server/auth/session';

export type LoginState = { error: string | null };

/**
 * Sign-in runs entirely on the server: the browser posts a form and gets back
 * either a redirect or a message. No token is handed to client JavaScript, so
 * there is nothing in the page for a script to read or replay.
 */
export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  const requestHeaders = await headers();
  const result = await signIn(email, password, requestHeaders.get('user-agent'));

  if (!result.ok) return { error: result.message };

  // redirect() throws to unwind, so it must sit outside any try/catch.
  redirect('/');
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect('/login');
}
