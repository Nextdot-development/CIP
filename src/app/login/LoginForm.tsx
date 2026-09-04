'use client';

import { useActionState } from 'react';
import { login } from '../actions';
import type { LoginState } from '../actions';
import { Icon } from '@/components/ui/Icon';

const INITIAL: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, INITIAL);

  return (
    <form action={formAction} className="auth-form">
      <label className="field">
        <span className="field-label">Work email</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          placeholder="you@yourcompany.com"
          aria-describedby={state.error ? 'signin-error' : undefined}
        />
      </label>

      <label className="field">
        <span className="field-label">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="Your password"
          aria-describedby={state.error ? 'signin-error' : undefined}
        />
      </label>

      {state.error && (
        <p className="auth-error" id="signin-error" role="alert">
          <Icon name="alert" size={16} />
          {state.error}
        </p>
      )}

      <button type="submit" className="btn btn-primary auth-submit" disabled={pending}>
        {pending ? 'Signing you in...' : 'Sign in'}
        {!pending && <Icon name="arrow-right" size={16} />}
      </button>
    </form>
  );
}
