'use server';

import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { signIn } from '@/server/auth/signIn';
import { destroySession } from '@/server/auth/session';
import { requireSession } from '@/server/auth/guards';
import { companyBrands } from '@/server/brain/brands';
import { ACTIVE_BRAND_COOKIE } from '@/server/brain/activeBrand';

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

/**
 * The brand switcher.
 *
 * Only a brand on this company's roster can be chosen; anything else clears
 * the choice. Revalidating the layout re-renders every page for the new brand
 * without the browser having to reload.
 */
export async function setActiveBrand(name: string | null): Promise<void> {
  const session = await requireSession();
  const brands = await companyBrands(session.scope);
  const match = name ? brands.find((brand) => brand.name === name) : undefined;

  const jar = await cookies();
  if (match) {
    jar.set(ACTIVE_BRAND_COOKIE, match.name, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 180,
    });
  } else {
    jar.delete(ACTIVE_BRAND_COOKIE);
  }
  revalidatePath('/', 'layout');
}
