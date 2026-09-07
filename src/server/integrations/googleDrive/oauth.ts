import 'server-only';

/**
 * Where Google sends the browser back to.
 *
 * Taken from configuration when it is set, because the value has to match what
 * is registered in the Google console exactly. Otherwise it is derived from the
 * request, which keeps a development machine working on whatever port it
 * happens to be using.
 */
export function redirectUri(request: Request): string {
  const configured = process.env.GOOGLE_REDIRECT_URI;
  if (configured) return configured;

  const url = new URL(request.url);
  return `${url.origin}/api/integrations/google-drive/callback`;
}
