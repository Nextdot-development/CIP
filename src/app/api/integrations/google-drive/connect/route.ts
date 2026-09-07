import { redirect } from 'next/navigation';
import { requireSessionOr401 } from '@/server/auth/guards';
import { DRIVE_SCOPE, googleDrive } from '@/server/integrations/googleDrive';
import { issueOAuthState } from '@/server/integrations/googleDrive/connection';
import { noStore } from '@/server/drive/http';
import { redirectUri } from '@/server/integrations/googleDrive/oauth';

/**
 * GET /api/integrations/google-drive/connect
 *
 * Starts the OAuth flow by sending the browser to Google's consent screen.
 *
 * A shared or public Drive URL is deliberately not accepted anywhere as a
 * substitute for this: a link proves nothing about who may read a folder, and
 * pasting one would let anybody attach any Drive they could see. Access comes
 * from a grant the Google account holder makes, and nothing else.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  const api = googleDrive();
  if (!api.configured) {
    return Response.json(
      {
        error: 'PROVIDER_NOT_CONFIGURED',
        message: 'Google Drive is not configured on this server.',
      },
      { status: 503, headers: noStore },
    );
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(request),
    response_type: 'code',
    // Read-only, and only Drive. The least privilege that can list a folder
    // and download what is in it.
    scope: `${DRIVE_SCOPE} openid email`,
    // offline so a refresh token arrives; consent so one arrives even when the
    // account has approved CIP before, which is what makes reconnecting work.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state: issueOAuthState(auth.session.scope),
  });

  redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
