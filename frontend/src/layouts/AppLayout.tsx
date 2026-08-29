import { Outlet } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import ThemeToggle from '@/components/ThemeToggle';

/**
 * App shell: sidebar + top bar + routed main area.
 */
export default function AppLayout() {
  return (
    <div className="app">
      <Sidebar />
      <header className="app-header">
        <div className="app-title">
          <h1>mDEV Hotspot Manager</h1>
          <div className="badge">Manage your OpenWrt routers remotely</div>
        </div>
        <div className="row">
          <ThemeToggle />
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
