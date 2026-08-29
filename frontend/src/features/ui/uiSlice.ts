import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  message: string;
  /** Auto-dismiss in ms. 0 = sticky. */
  ttl: number;
}

interface UIState {
  toasts: Toast[];
  /** When set, the sidebar is collapsed on mobile. */
  mobileNavOpen: boolean;
}

const initialState: UIState = {
  toasts: [],
  mobileNavOpen: false,
};

let nextId = 0;
const genId = () => `t${Date.now().toString(36)}-${(nextId += 1)}`;

const slice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    toastAdded: {
      reducer(state, action: PayloadAction<Toast>) {
        state.toasts.push(action.payload);
      },
      prepare(input: { kind: Toast['kind']; message: string; ttl?: number }) {
        return {
          payload: {
            id: genId(),
            kind: input.kind,
            message: input.message,
            ttl: input.ttl ?? 5000,
          },
        };
      },
    },
    toastRemoved(state, action: PayloadAction<string>) {
      state.toasts = state.toasts.filter((t) => t.id !== action.payload);
    },
    setMobileNavOpen(state, action: PayloadAction<boolean>) {
      state.mobileNavOpen = action.payload;
    },
    reset() {
      return initialState;
    },
  },
});

export const { toastAdded, toastRemoved, setMobileNavOpen, reset: resetUI } = slice.actions;
export default slice.reducer;

export const selectToasts = (s: { ui: UIState }) => s.ui.toasts;
export const selectMobileNavOpen = (s: { ui: UIState }) => s.ui.mobileNavOpen;
