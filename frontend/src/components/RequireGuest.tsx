import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAppSelector } from '@/store/hooks';
import { selectIsAuthenticated } from '@/features/auth/authSlice';

/**
 * Inverse of RequireAuth: only renders children for signed-out users
 * (e.g. /login, /register). If already authenticated, sends the user
 * to /routers.
 */
export function RequireGuest({ children }: { children: React.ReactNode }) {
  const isAuthed = useAppSelector(selectIsAuthenticated);
  if (isAuthed) return <Navigate to="/routers" replace />;
  return <>{children}</>;
}

export default RequireGuest;
