import {
  createSlice,
  createAsyncThunk,
  type PayloadAction,
} from '@reduxjs/toolkit';

import { AuthApi, getToken, clearToken as clearPersistedToken, setToken as persistToken } from '@/services/api';
import type { User } from '@/types';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated' | 'failed';

interface AuthState {
  token: string | null;
  user: User | null;
  status: AuthStatus;
  /** True only while the initial /me bootstrap on app boot is running. */
  bootstrapping: boolean;
  error: string | null;
}

const initialState: AuthState = {
  // On boot, hydrate from the token we persisted to localStorage
  // (if any).  We don't load the user from storage -- we'll always
  // re-verify it with /me once the app is mounted.
  token: getToken(),
  user: null,
  status: 'idle',
  bootstrapping: false,
  error: null,
};

/* ------------------------------------------------------------------ */
/*  Thunks                                                            */
/* ------------------------------------------------------------------ */

interface AuthResult {
  token: string;
  user: User;
}

interface RejectShape {
  message: string;
  field?: 'email' | 'password' | 'displayName';
}

export const login = createAsyncThunk<AuthResult, { email: string; password: string }, { rejectValue: RejectShape }>(
  'auth/login',
  async (input, { rejectWithValue }) => {
    try {
      const { token, user } = await AuthApi.login(input);
      persistToken(token);
      return { token, user };
    } catch (e: any) {
      return rejectWithValue({ message: e?.userMessage ?? e?.message ?? 'Login failed' });
    }
  }
);

export const register = createAsyncThunk<
  AuthResult,
  { email: string; password: string; displayName?: string },
  { rejectValue: RejectShape }
>('auth/register', async (input, { rejectWithValue }) => {
  try {
    const { token, user } = await AuthApi.register(input);
    persistToken(token);
    return { token, user };
  } catch (e: any) {
    return rejectWithValue({ message: e?.userMessage ?? e?.message ?? 'Registration failed' });
  }
});

/** Called once on app boot.  If a token is persisted, verify it with
 *  /me.  On success we know the user is authenticated.  On 401 the
 *  axios interceptor clears the token. */
export const fetchMe = createAsyncThunk<
  { user: User; token: string },
  void,
  { state: { auth: AuthState } }
>('auth/fetchMe', async (_, { getState, rejectWithValue }) => {
  const token = getState().auth.token;
  if (!token) return rejectWithValue({ message: 'No token' });
  try {
    const { user } = await AuthApi.me();
    return { user, token };
  } catch (e: any) {
    return rejectWithValue({ message: e?.userMessage ?? 'Session expired' });
  }
});

export const logout = createAsyncThunk<void, void>(
  'auth/logout',
  async () => {
    await AuthApi.logout();
    clearPersistedToken();
  }
);

/* ------------------------------------------------------------------ */
/*  Slice                                                             */
/* ------------------------------------------------------------------ */

const slice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    /** Used by the axios 401 interceptor to drop the user back to
     *  "logged out" without making an extra /auth/logout call. */
    clearAuth(state) {
      state.token = null;
      state.user = null;
      state.status = 'unauthenticated';
      state.error = null;
      state.bootstrapping = false;
    },
  },
  extraReducers: (b) => {
    /* -- login -- */
    b.addCase(login.pending, (s) => {
      s.status = 'loading';
      s.error = null;
    });
    b.addCase(login.fulfilled, (s, a: PayloadAction<AuthResult>) => {
      s.token = a.payload.token;
      s.user = a.payload.user;
      s.status = 'authenticated';
      s.error = null;
    });
    b.addCase(login.rejected, (s, a) => {
      s.status = 'failed';
      s.error = a.payload?.message ?? a.error.message ?? 'Login failed';
    });

    /* -- register -- */
    b.addCase(register.pending, (s) => {
      s.status = 'loading';
      s.error = null;
    });
    b.addCase(register.fulfilled, (s, a) => {
      s.token = a.payload.token;
      s.user = a.payload.user;
      s.status = 'authenticated';
      s.error = null;
    });
    b.addCase(register.rejected, (s, a) => {
      s.status = 'failed';
      s.error = a.payload?.message ?? a.error.message ?? 'Registration failed';
    });

    /* -- /me bootstrap -- */
    b.addCase(fetchMe.pending, (s) => {
      s.bootstrapping = true;
    });
    b.addCase(fetchMe.fulfilled, (s, a) => {
      s.token = a.payload.token;
      s.user = a.payload.user;
      s.status = 'authenticated';
      s.bootstrapping = false;
      s.error = null;
    });
    b.addCase(fetchMe.rejected, (s) => {
      s.token = null;
      s.user = null;
      s.status = 'unauthenticated';
      s.bootstrapping = false;
    });

    /* -- logout -- */
    b.addCase(logout.fulfilled, (s) => {
      s.token = null;
      s.user = null;
      s.status = 'unauthenticated';
      s.error = null;
    });
  },
});

export const { clearAuth } = slice.actions;
export default slice.reducer;

/* ------------------------------------------------------------------ */
/*  Selectors                                                         */
/* ------------------------------------------------------------------ */

export const selectAuth = (s: { auth: AuthState }) => s.auth;
export const selectIsAuthenticated = (s: { auth: AuthState }) =>
  s.auth.status === 'authenticated' && !!s.auth.token && !!s.auth.user;
export const selectUser = (s: { auth: AuthState }) => s.auth.user;
export const selectAuthStatus = (s: { auth: AuthState }) => s.auth.status;
export const selectAuthError = (s: { auth: AuthState }) => s.auth.error;
export const selectBootstrapping = (s: { auth: AuthState }) => s.auth.bootstrapping;
