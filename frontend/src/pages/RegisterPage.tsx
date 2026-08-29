import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { register, selectAuthStatus, selectAuthError } from '@/features/auth/authSlice';
import { useToast } from '@/features/ui/useToast';

export default function RegisterPage() {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectAuthStatus);
  const error = useAppSelector(selectAuthError);
  const navigate = useNavigate();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);

  const submitting = status === 'loading';

  useEffect(() => {
    if (status === 'failed' && error) toast('error', error, 4000);
  }, [status, error, toast]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setLocalErr('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setLocalErr('Password must be at least 8 characters');
      return;
    }
    setLocalErr(null);

    const action = await dispatch(
      register({
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
      })
    );
    if (register.fulfilled.match(action)) {
      toast('success', 'Account created');
      navigate('/routers', { replace: true });
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card card">
        <h1 className="auth-title">Create account</h1>
        <p className="muted">Manage OpenWrt routers worldwide.</p>

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
            <span>Display name <span className="dim">(optional)</span></span>
            <input
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={submitting}
            />
          </label>
          <label>
            <span>Password <span className="dim">(min 8 chars)</span></span>
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </label>
          <label>
            <span>Confirm password</span>
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={submitting}
            />
          </label>

          <button type="submit" disabled={submitting}>
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        {(localErr || (status === 'failed' && error)) && (
          <div className="banner error" style={{ marginTop: 12 }}>
            {localErr ?? error}
          </div>
        )}

        <div className="auth-alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
