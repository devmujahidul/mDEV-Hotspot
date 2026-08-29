import { RouterProvider } from 'react-router-dom';
import { router } from '@/routes/router';
import ErrorBoundary from '@/components/ErrorBoundary';
import Toaster from '@/components/Toaster';

/**
 * Root component: supplies the router, wraps everything in an
 * ErrorBoundary so render-time failures show a recoverable UI, and
 * mounts the toast viewport.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
      <Toaster />
    </ErrorBoundary>
  );
}
