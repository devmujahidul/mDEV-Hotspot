import {
  createSlice,
  createAsyncThunk,
  type PayloadAction,
} from '@reduxjs/toolkit';

import { RoutersApi } from '@/services/api';
import type { Router, RouterRotateTokenResponse, RouterWithInstallToken } from '@/types';

export type ListStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

export interface RebootResult {
  routerId: string;
  ok: boolean;
  message: string;
  ts: number;
}

export interface InstallTokenRecord {
  routerId: string;
  token: string;
  command: string;
  ts: number;
}

/* ------------------------------------------------------------------ */
/*  Install-token persistence                                         */
/*                                                                   */
/*  The backend returns the plaintext install token exactly once.    */
/*  If the user reloads the tab before pasting the one-liner, the   */
/*  in-memory slice state is lost. We therefore persist the most     */
/*  recent install token to localStorage, keyed by routerId, so the  */
/*  user can recover it from the router detail page even after a     */
/*  refresh or new tab.                                              */
/*                                                                   */
/*  Same trust model as the JWT (which already lives in localStorage)*/
/* ------------------------------------------------------------------ */

const TOKEN_MAP_KEY = 'mdev:installTokens';
const TOKEN_FOCUS_KEY = 'mdev:lastInstallTokenRouterId';

type PersistedTokens = Record<string, InstallTokenRecord>;

/**
 * A persisted record is only usable if every field we need at render time
 * is present and of the right primitive type.  Older or partial entries
 * (e.g. one written by a different version of the app, or corrupted by a
 * hand-edit of localStorage) would otherwise produce a panel showing
 * `undefined` for the command and token — exactly the bug we hit when a
 * user had a stale entry under `mdev:installTokens` from an earlier
 * install of the app.  Drop those at the boundary so the rest of the
 * code can trust the type.
 */
function isValidTokenRecord(x: unknown): x is InstallTokenRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.routerId === 'string' &&
    r.routerId.length > 0 &&
    typeof r.token === 'string' &&
    r.token.length > 0 &&
    typeof r.command === 'string' &&
    r.command.length > 0 &&
    typeof r.ts === 'number'
  );
}

function readPersistedTokens(): PersistedTokens {
  try {
    const raw = window.localStorage.getItem(TOKEN_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // Filter out partial / malformed entries on read.  If we filtered
    // any, rewrite the cleaned map so the bad data doesn't keep coming
    // back on every page load.
    const out: PersistedTokens = {};
    let changed = false;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidTokenRecord(v)) out[k] = v;
      else changed = true;
    }
    if (changed) writePersistedTokensRaw(out);
    return out;
  } catch {
    /* ignore corrupt / unavailable storage */
    return {};
  }
}

function writePersistedTokensRaw(map: PersistedTokens): void {
  try {
    window.localStorage.setItem(TOKEN_MAP_KEY, JSON.stringify(map));
  } catch {
    /* localStorage may be unavailable in private mode */
  }
}

function writePersistedTokens(map: PersistedTokens): void {
  // Re-validate before writing so we can never persist a malformed
  // record from inside the slice (defence-in-depth — the reducers
  // already pass full records, but this guarantees the on-disk shape).
  const cleaned: PersistedTokens = {};
  for (const [k, v] of Object.entries(map)) {
    if (isValidTokenRecord(v)) cleaned[k] = v;
  }
  writePersistedTokensRaw(cleaned);
}

function persistToken(rec: InstallTokenRecord): void {
  if (!isValidTokenRecord(rec)) return;
  const map = readPersistedTokens();
  map[rec.routerId] = rec;
  writePersistedTokens(map);
  try {
    window.localStorage.setItem(TOKEN_FOCUS_KEY, rec.routerId);
  } catch {
    /* noop */
  }
}

function removePersistedToken(routerId: string): void {
  if (!routerId) return;
  const map = readPersistedTokens();
  if (routerId in map) {
    delete map[routerId];
    writePersistedTokens(map);
  }
  try {
    if (window.localStorage.getItem(TOKEN_FOCUS_KEY) === routerId) {
      window.localStorage.removeItem(TOKEN_FOCUS_KEY);
    }
  } catch {
    /* noop */
  }
}

function hydrateInitialLastToken(): InstallTokenRecord | null {
  const map = readPersistedTokens(); // already filtered by isValidTokenRecord
  let focusId: string | null = null;
  try {
    focusId = window.localStorage.getItem(TOKEN_FOCUS_KEY);
  } catch {
    /* noop */
  }
  if (focusId && map[focusId]) return map[focusId];
  // Fall back to the most-recently-issued token we still have.
  let best: InstallTokenRecord | null = null;
  for (const rec of Object.values(map)) {
    if (!best || rec.ts > best.ts) best = rec;
  }
  return best;
}

interface RoutersState {
  list: Router[];
  byId: Record<string, Router>;
  listStatus: ListStatus;
  listError: string | null;
  lastReboot: RebootResult | null;
  lastInstallToken: InstallTokenRecord | null;
  mutating: Record<string, boolean>;
}

const initialState: RoutersState = {
  list: [],
  byId: {},
  listStatus: 'idle',
  listError: null,
  lastReboot: null,
  lastInstallToken: hydrateInitialLastToken(),
  mutating: {},
};

/* ------------------------------------------------------------------ */
/*  Thunks                                                            */
/* ------------------------------------------------------------------ */

export const fetchRouters = createAsyncThunk<Router[], void, { rejectValue: string }>(
  'routers/fetchAll',
  async (_, { rejectWithValue }) => {
    try {
      return await RoutersApi.list();
    } catch (e: any) {
      return rejectWithValue(e?.userMessage ?? 'Failed to load routers');
    }
  }
);

export const createRouter = createAsyncThunk<
  RouterWithInstallToken,
  { routerId: string; name?: string; macAddress: string },
  { rejectValue: string }
>('routers/create', async (input, { rejectWithValue }) => {
  try {
    return await RoutersApi.create(input);
  } catch (e: any) {
    return rejectWithValue(e?.userMessage ?? 'Failed to create router');
  }
});

export const updateRouter = createAsyncThunk<
  Router,
  { routerId: string; name?: string; macAddress?: string },
  { rejectValue: string }
>('routers/update', async ({ routerId, ...rest }, { rejectWithValue }) => {
  try {
    return await RoutersApi.update(routerId, rest);
  } catch (e: any) {
    return rejectWithValue(e?.userMessage ?? 'Failed to update router');
  }
});

export const deleteRouter = createAsyncThunk<string, string, { rejectValue: string }>(
  'routers/delete',
  async (routerId, { rejectWithValue }) => {
    try {
      await RoutersApi.remove(routerId);
      return routerId;
    } catch (e: any) {
      return rejectWithValue(e?.userMessage ?? 'Failed to delete router');
    }
  }
);

export const rotateInstallToken = createAsyncThunk<
  RouterRotateTokenResponse,
  string,
  { rejectValue: string }
>('routers/rotateToken', async (routerId, { rejectWithValue }) => {
  try {
    return await RoutersApi.rotateToken(routerId);
  } catch (e: any) {
    return rejectWithValue(e?.userMessage ?? 'Failed to rotate token');
  }
});

export const rebootRouter = createAsyncThunk<
  RebootResult,
  string,
  { rejectValue: RebootResult }
>('routers/reboot', async (routerId, { rejectWithValue }) => {
  try {
    const res = await RoutersApi.reboot(routerId);
    return {
      routerId,
      ok: res.ok && res.result.status !== 'error',
      message: res.result.message || 'Reboot accepted',
      ts: Date.now(),
    };
  } catch (e: any) {
    return rejectWithValue({
      routerId,
      ok: false,
      message: e?.userMessage ?? e?.message ?? 'Reboot failed',
      ts: Date.now(),
    });
  }
});

/* ------------------------------------------------------------------ */
/*  Slice                                                             */
/* ------------------------------------------------------------------ */

function indexById(list: Router[]): Record<string, Router> {
  const out: Record<string, Router> = {};
  for (const r of list) out[r.routerId] = r;
  return out;
}

const slice = createSlice({
  name: 'routers',
  initialState,
  reducers: {
    clearLastReboot(state) {
      state.lastReboot = null;
    },
    clearLastInstallToken(state) {
      if (state.lastInstallToken) {
        removePersistedToken(state.lastInstallToken.routerId);
      }
      state.lastInstallToken = null;
    },
    /** Optimistic-ish status set by an external WS / heartbeat layer. */
    setRouterStatus(
      state,
      action: PayloadAction<{ routerId: string; status: Router['status']; lastSeen?: string }>
    ) {
      const r = state.byId[action.payload.routerId];
      if (r) {
        r.status = action.payload.status;
        if (action.payload.lastSeen) r.lastSeen = action.payload.lastSeen;
      }
    },
    reset() {
      return initialState;
    },
  },
  extraReducers: (b) => {
    b.addCase(fetchRouters.pending, (s) => {
      s.listStatus = 'loading';
      s.listError = null;
    });
    b.addCase(fetchRouters.fulfilled, (s, a: PayloadAction<Router[]>) => {
      s.listStatus = 'succeeded';
      s.list = a.payload;
      s.byId = indexById(a.payload);
    });
    b.addCase(fetchRouters.rejected, (s, a) => {
      s.listStatus = 'failed';
      s.listError = a.payload ?? a.error.message ?? 'Failed to load routers';
    });

    b.addCase(createRouter.fulfilled, (s, a) => {
      const payload = a.payload;
      const r = payload as Router;
      if (!r.routerId) return;
      s.list = [r, ...s.list];
      s.byId[r.routerId] = r;
      const rec: InstallTokenRecord = {
        routerId: r.routerId,
        token: (payload as RouterWithInstallToken).installToken,
        command: (payload as RouterWithInstallToken).installCommand,
        ts: Date.now(),
      };
      if (isValidTokenRecord(rec)) {
        s.lastInstallToken = rec;
        persistToken(rec);
      }
    });

    b.addCase(updateRouter.fulfilled, (s, a) => {
      const r = a.payload;
      s.list = s.list.map((x) => (x.routerId === r.routerId ? r : x));
      s.byId[r.routerId] = r;
    });

    b.addCase(deleteRouter.fulfilled, (s, a) => {
      const removedId = a.payload;
      s.list = s.list.filter((x) => x.routerId !== removedId);
      delete s.byId[removedId];
      // Drop any persisted install token for the deleted router so the
      // next session doesn't try to "recover" a command for a router
      // that no longer exists.
      if (s.lastInstallToken?.routerId === removedId) {
        s.lastInstallToken = null;
      }
      removePersistedToken(removedId);
    });

    b.addCase(rotateInstallToken.fulfilled, (s, a) => {
      const payload = a.payload;
      const router = payload?.router;
      if (!router || typeof router.routerId !== 'string' || !router.routerId) {
        // Contract says the backend always returns the refreshed router;
        // if it somehow doesn't, leave the map/registry untouched rather
        // than corrupting byId with an undefined key or showing a
        // "(unknown)" install panel.
        return;
      }
      s.list = s.list.map((x) => (x.routerId === router.routerId ? router : x));
      s.byId[router.routerId] = router;
      const rec: InstallTokenRecord = {
        routerId: router.routerId,
        token: payload.installToken,
        command: payload.installCommand,
        ts: Date.now(),
      };
      if (isValidTokenRecord(rec)) {
        s.lastInstallToken = rec;
        persistToken(rec);
      }
    });

    b.addCase(rebootRouter.pending, (s, a) => {
      s.mutating[a.meta.arg] = true;
      s.lastReboot = null;
    });
    b.addCase(rebootRouter.fulfilled, (s, a) => {
      delete s.mutating[a.payload.routerId];
      s.lastReboot = a.payload;
    });
    b.addCase(rebootRouter.rejected, (s, a) => {
      if (a.payload) {
        delete s.mutating[a.payload.routerId];
        s.lastReboot = a.payload;
      }
    });
  },
});

export const {
  clearLastReboot,
  clearLastInstallToken,
  setRouterStatus,
  reset: resetRouters,
} = slice.actions;
export default slice.reducer;

/* ------------------------------------------------------------------ */
/*  Selectors                                                         */
/* ------------------------------------------------------------------ */

export const selectRouters = (s: { routers: RoutersState }) => s.routers.list;
export const selectRoutersById = (s: { routers: RoutersState }) => s.routers.byId;
export const selectRouterById = (id: string) => (s: { routers: RoutersState }) =>
  s.routers.byId[id];
export const selectListStatus = (s: { routers: RoutersState }) => s.routers.listStatus;
export const selectListError = (s: { routers: RoutersState }) => s.routers.listError;
export const selectLastReboot = (s: { routers: RoutersState }) => s.routers.lastReboot;
export const selectLastInstallToken = (s: { routers: RoutersState }) =>
  s.routers.lastInstallToken;

/**
 * Read the install-token record for a given routerId, if we have one
 * stored in either the slice (in-memory) or localStorage (persistent).
 *
 * Use this from the router detail page so the user can recover their
 * install command even if they navigate around, refresh, or close the
 * tab. The result is intentionally read-only — calling
 * `clearLastInstallToken` only wipes the in-memory record (the
 * persisted one is dropped via the reducers when the same router is
 * re-issued or deleted).
 */
export function readPersistedInstallToken(
  routerId: string,
  fromSlice: InstallTokenRecord | null
): InstallTokenRecord | null {
  if (fromSlice && fromSlice.routerId === routerId) return fromSlice;
  const map = readPersistedTokens();
  return map[routerId] ?? null;
}
export const selectIsMutating = (id: string) => (s: { routers: RoutersState }) =>
  !!s.routers.mutating[id];

