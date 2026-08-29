import {
  configureStore,
  combineReducers,
  type Middleware,
  type AnyAction,
} from '@reduxjs/toolkit';
import {
  persistStore,
  persistReducer,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
} from 'redux-persist';
import storage from 'redux-persist/lib/storage';

import auth, { logout as logoutAction } from '@/features/auth/authSlice';
import routers, { resetRouters } from '@/features/routers/routersSlice';
import ui, { resetUI } from '@/features/ui/uiSlice';

const rootReducer = combineReducers({ auth, routers, ui });

/* Only persist `auth.token` (we don't want to persist user info; we'll
 * always re-fetch /me on app boot).  Everything else is live. */
const persistConfig = {
  key: 'mdev',
  version: 1,
  storage,
  whitelist: ['auth'],
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

/** Drop the persisted token and reset live state when the user logs
 *  out (also wired to the axios 401 interceptor). */
const logoutMiddleware: Middleware = (api) => (next) => (action) => {
  const result = next(action);
  if ((action as AnyAction).type === logoutAction.fulfilled.type) {
    api.dispatch(resetRouters());
    api.dispatch(resetUI());
  }
  return result;
};

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }).concat(logoutMiddleware),
});

export const persistor = persistStore(store);

/* ---------- Typed hooks ---------- */

export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = typeof store.dispatch;

