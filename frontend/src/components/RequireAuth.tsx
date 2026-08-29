import React, { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  fetchMe,
  selectIsAuthenticated,
  selectBootstrapping,
} from '@/features/auth/authSlice';
import { getToken } from '@/services/api';

/**
 * Route guard for authenticated routes.
 *
 *   - While we don't know yet (bootstrapping /me), show a spinner.
 *   - If we have a token but /me failed, drop it and go to /login.
 *   - If we're authenticated, render the children.
 *   - Otherwise, redirect to /login with the original URL preserved.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const dispatch = useAppDispatch();
  const isAuthed = useAppSelector(selectIsAuthenticated);
  const bootstrapping = useAppSelector(selectBootstrapping);
  const location = useLocation();

  useEffect(() => {
    if (isAuthed || !getToken()) return;
    dispatch(fetchMe());
  }, [dispatch, isAuthed]);

  if (isAuthed) return <>{children}</>;
  if (bootstrapping) {
    return (
      <div style={{ padding: 64, textAlign: 'center', color: 'var(--text-muted)' }}>
        Restoring session…
      </div>
    );
  }
  return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
}

export default RequireAuth;
