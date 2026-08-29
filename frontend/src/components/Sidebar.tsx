import { NavLink, useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { selectUser, logout } from '@/features/auth/authSlice';
import { resetRouters } from '@/features/routers/routersSlice';
import { resetUI } from '@/features/ui/uiSlice';
import { useToast } from '@/features/ui/useToast';

const items = [
  { to: '/routers',  label: 'Routers' },
  { to: '/settings', label: 'Settings' },
  { to: '/about',    label: 'About' },
];

export default function Sidebar() {
  const user = useAppSelector(selectUser);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const toast = useToast();

  const onLogout = async () => {
    await dispatch(logout());
    dispatch(resetRouters());
    dispatch(resetUI());
    toast('info', 'Signed out');
    navigate('/login', { replace: true });
  };

  return (
    <nav className="app-sidebar">
      <div className="sidebar-brand">
        <span className="dot" />
        mDEV Hotspot
      </div>

      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          {it.label}
        </NavLink>
      ))}

      <div className="sidebar-account">
        <div className="account-name">{user?.displayName || user?.email || 'Signed in'}</div>
        <div className="account-email">{user?.email}</div>
        <button className="ghost logout" onClick={onLogout}>
          Sign out
        </button>
      </div>

      <div className="sidebar-footer">v1.2.0</div>
    </nav>
  );
}
