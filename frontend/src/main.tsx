import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';

import { store, persistor } from '@/store';
import { registerUnauthorizedHandler } from '@/services/api';
import { clearAuth } from '@/features/auth/authSlice';
import { ThemeProvider } from '@/theme/ThemeProvider';
import App from '@/App';
import '@/styles/index.css';

// Wire the axios 401 interceptor to a Redux action: on a 401 response,
// drop the persisted token and reset live state so RequireAuth routes
// the user to /login on the next render.
registerUnauthorizedHandler(() => {
  store.dispatch(clearAuth());
});

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </PersistGate>
    </Provider>
  </React.StrictMode>
);

