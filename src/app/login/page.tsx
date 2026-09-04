import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in — CIP' };

// Session state is per-request; nothing on this page may be cached.
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // Already signed in? Nothing to do here.
  if (await getSession()) redirect('/');

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="wordmark">CIP</span>
          <span className="promise">Create. Comply. Perform.</span>
        </div>
        <h1>Sign in</h1>
        <p className="auth-lede">
          Your workspace opens automatically — CIP knows which company you belong to.
        </p>
        <LoginForm />
      </div>
      <p className="auth-foot">One workspace per company. Nothing is shared between them.</p>
    </main>
  );
}
