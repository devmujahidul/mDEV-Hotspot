import { useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  login as loginAction,
  register as registerAction,
  logout as logoutAction,
  fetchMe,
  clearAuth,
  selectIsAuthenticated,
  selectUser,
  selectAuthStatus,
  selectAuthError,
  selectBootstrapping,
} from './authSlice';

/**
 * Single import for all auth concerns.
 *
 *   const { user, isAuthenticated, login, register, logout } = useAuth();
 */
export function useAuth() {
  const dispatch = useAppDispatch();
  const user = useAppSelector(selectUser);
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const status = useAppSelector(selectAuthStatus);
  const error = useAppSelector(selectAuthError);
  const bootstrapping = useAppSelector(selectBootstrapping);

  const loginAsync = useCallback(
    (input: { email: string; password: string }) => dispatch(loginAction(input)),
    [dispatch]
  );
  const registerAsync = useCallback(
    (input: { email: string; password: string; displayName?: string }) =>
      dispatch(registerAction(input)),
    [dispatch]
  );
  const logoutAsync = useCallback(() => dispatch(logoutAction()), [dispatch]);
  const refreshMe = useCallback(() => dispatch(fetchMe()), [dispatch]);
  const clear = useCallback(() => dispatch(clearAuth()), [dispatch]);

  return {
    user,
    isAuthenticated,
    status,
    error,
    bootstrapping,
    login: loginAsync,
    register: registerAsync,
    logout: logoutAsync,
    refreshMe,
    clear,
  };
}
