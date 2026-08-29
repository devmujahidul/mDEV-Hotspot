import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { selectUser, logout, clearAuth } from '@/features/auth/authSlice';
import { resetRouters } from '@/features/routers/routersSlice';
import { resetUI } from '@/features/ui/uiSlice';
import { useToast } from '@/features/ui/useToast';
import { PUBLIC_ORIGIN } from '@/services/api';
import CopyableCode from '@/components/CopyableCode';

export default function SettingsPage() {
  const user = useAppSelector(selectUser);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const onSignOut = async () => {
    if (!window.confirm('Sign out of your account?')) return;
    setBusy(true);
    await dispatch(logout());
    dispatch(resetRouters());
    dispatch(resetUI());
    setBusy(false);
    toast('info', 'Signed out');
    navigate('/login', { replace: true });
  };

  const onClearLocal = () => {
    if (!window.confirm('Clear locally stored session on this device?')) return;
    dispatch(clearAuth());
    dispatch(resetRouters());
    dispatch(resetUI());
    toast('info', 'Local session cleared');
    navigate('/login', { replace: true });
  };

  const installScriptUrl = `${PUBLIC_ORIGIN}/install.sh`;
  const uninstallCmd =
    `# On the router, run:\nsh /tmp/mdev_install.sh --uninstall   # (if still present)\n# Or manually:\n/etc/init.d/mdev_agent stop\n/etc/init.d/mdev_agent disable\nrm -f /usr/bin/mDEV_agent /etc/mdev_agent.conf /etc/init.d/mdev_agent`;

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Settings</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Account</h3>
        <div className="kv">
          <div>Display name</div>
          <div>{user?.displayName || '—'}</div>
          <div>Email</div>
          <div><code>{user?.email}</code></div>
          <div>User ID</div>
          <div><code>{user?.id}</code></div>
          <div>Joined</div>
          <div>{user?.createdAt}</div>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          Account editing (display name, password change, email change) is
          coming next.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Agent install script</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          The portal serves a single <code>install.sh</code> that you can
          preview or fetch from any device.  The generic command below only
          prints the installer&apos;s <code>--help</code> — to actually install
          on a router, add the router first; its detail page will show a
          one-liner with the install token already embedded.
        </p>
        <div className="kv">
          <div>Install script URL</div>
          <div>
            <a href={installScriptUrl} target="_blank" rel="noopener noreferrer">
              <code>{installScriptUrl}</code>
            </a>
          </div>
          <div>Generic preview</div>
          <div>
            <CopyableCode
              value={`curl -fsSL "${installScriptUrl}" | sh -s -- --help`}
            />
          </div>
        </div>
        <details style={{ marginTop: 12 }}>
          <summary className="muted">Uninstall instructions</summary>
          <CopyableCode value={uninstallCmd} />
        </details>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Session</h3>
        <p className="muted">
          Your JWT is stored in this browser&apos;s <code>localStorage</code>.
          Signing out will call the backend and clear the local token.
        </p>
        <div className="row">
          <button onClick={onSignOut} disabled={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
          <button className="ghost" onClick={onClearLocal}>
            Clear local session
          </button>
        </div>
      </div>
    </section>
  );
}
