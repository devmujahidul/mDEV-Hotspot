import { createBrowserRouter, Navigate } from 'react-router-dom';

import AppLayout from '@/layouts/AppLayout';
import RequireAuth from '@/components/RequireAuth';
import RequireGuest from '@/components/RequireGuest';
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';
import RoutersListPage from '@/pages/RoutersListPage';
import RouterDetailPage from '@/pages/RouterDetailPage';
import SettingsPage from '@/pages/SettingsPage';
import AboutPage from '@/pages/AboutPage';

export const router = createBrowserRouter([
  /* Public routes */
  { path: '/login',    element: <RequireGuest><LoginPage /></RequireGuest> },
  { path: '/register', element: <RequireGuest><RegisterPage /></RequireGuest> },

  /* Authenticated routes */
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true,         element: <Navigate to="/routers" replace /> },
      { path: 'routers',     element: <RoutersListPage /> },
      { path: 'routers/:id', element: <RouterDetailPage /> },
      { path: 'settings',    element: <SettingsPage /> },
      { path: 'about',       element: <AboutPage /> },
      { path: '*',           element: <Navigate to="/routers" replace /> },
    ],
  },
]);
