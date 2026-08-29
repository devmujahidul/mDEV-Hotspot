import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { login, selectAuthStatus, selectAuthError } from '@/features/auth/authSlice';
import { useToast } from '@/features/ui/useToast';

interface FromState {
  from?: string;
}

export default function LoginPage() {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectAuthStatus);
  const error = useAppSelector(selectAuthError);
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submitting = status === 'loading';

  useEffect(() => {
    /* Live error feedback: once the user submits and we get a 401 from
     * the backend, the slice stores the message in `error` and we toast it. */
    if (status === 'failed' && error) {
      toast('error', error, 4000);
    }
  }, [status, error, toast]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const action = await dispatch(login({ email: email.trim(), password }));
    if (login.fulfilled.match(action)) {
      toast('success', `Welcome back, ${action.payload.user.displayName || action.payload.user.email}`);
      const dest = (location.state as FromState | null)?.from || '/routers';
      navigate(dest, { replace: true });
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card card">
        <h1 className="auth-title">Sign in</h1>
        <p className="muted">Access your routers.</p>

        <form onSubmit={onSubmit} className="auth-form">
          <label>
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </label>

          <button type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {error && status === 'failed' && (
          <div className="banner error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div className="auth-alt">
          No account? <Link to="/register">Create one</Link>
        </div>
      </div>
    </div>
  );
}
