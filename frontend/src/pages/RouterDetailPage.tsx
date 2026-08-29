import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  fetchRouters,
  rebootRouter,
  deleteRouter,
  rotateInstallToken,
  updateRouter,
  selectRoutersById,
  selectListStatus,
  selectListError,
  selectIsMutating,
  selectLastReboot,
  selectLastInstallToken,
  readPersistedInstallToken,
} from '@/features/routers/routersSlice';
import { useToast } from '@/features/ui/useToast';
import { PUBLIC_ORIGIN } from '@/services/api';
import { normalizeMac } from '@/utils/mac';
import CopyableCode from '@/components/CopyableCode';
import type { Router } from '@/types';

function DeleteRouterButton({ router }: { router: Router }) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const mutating = useAppSelector(selectIsMutating(router.routerId));

  const onDelete = async () => {
    if (!window.confirm(`Delete router "${router.routerId}"? This cannot be undone.`)) return;
    setBusy(true);
    const action = await dispatch(deleteRouter(router.routerId));
    setBusy(false);
    if (deleteRouter.fulfilled.match(action)) {
      toast('success', 'Router removed');
      navigate('/routers');
    } else {
      toast('error', (action.payload as string) ?? 'Failed to delete router');
    }
  };

  return (
    <button
      className="danger"
      onClick={onDelete}
      disabled={busy || mutating}
      title="Permanently delete this router"
    >
      {busy ? 'Removing…' : 'Delete router'}
    </button>
  );
}

function RebootButton({ router }: { router: Router }) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const last = useAppSelector(selectLastReboot);
  const mutating = useAppSelector(selectIsMutating(router.routerId));
  const [busy, setBusy] = useState(false);

  const isRebooting =
    busy ||
    mutating ||
    (last?.routerId === router.routerId && last.ok && Date.now() - last.ts < 1500);
  const online = router.status === 'online';

  const onReboot = async () => {
    if (!window.confirm(`Reboot router "${router.routerId}"?`)) return;
    setBusy(true);
    const action = await dispatch(rebootRouter(router.routerId));
    setBusy(false);
    if (rebootRouter.fulfilled.match(action)) {
      toast('success', 'Reboot command sent');
    } else {
      toast('error', (action.payload as any)?.message ?? 'Reboot failed');
    }
  };

  return (
    <button
      className="danger"
      onClick={onReboot}
      disabled={!online || isRebooting}
      title={!online ? 'Router is offline' : 'Reboot this router'}
    >
      {isRebooting ? 'Rebooting…' : 'Reboot router'}
    </button>
  );
}

function RotateTokenButton({ router, busy }: { router: Router; busy?: boolean }) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [selfBusy, setSelfBusy] = useState(false);

  const onRotate = async () => {
    if (
      !window.confirm(
        `Rotate install token for "${router.routerId}"? Any installed agent will lose connection until re-installed.`
      )
    )
      return;
    setSelfBusy(true);
    const action = await dispatch(rotateInstallToken(router.routerId));
    setSelfBusy(false);
    if (rotateInstallToken.fulfilled.match(action)) {
      toast('success', 'Install token rotated');
    } else {
      toast('error', (action.payload as string) ?? 'Failed to rotate token');
    }
  };

  const isBusy = busy || selfBusy;
  return (
    <button onClick={onRotate} disabled={isBusy}>
      {isBusy ? 'Generating…' : 'Rotate install token'}
    </button>
  );
}

function EditMetaForm({ router }: { router: Router }) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [name, setName] = useState(router.name);
  const [mac, setMac] = useState(router.macAddress);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(router.name);
    setMac(router.macAddress);
  }, [router.name, router.macAddress]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);

    const normalized = normalizeMac(mac);
    if (!normalized) {
      setErr('Invalid MAC address');
      return;
    }

    setBusy(true);
    const action = await dispatch(
      updateRouter({
        routerId: router.routerId,
        name: name.trim(),
        macAddress: normalized,
      })
    );
    setBusy(false);
    if (updateRouter.fulfilled.match(action)) {
      toast('success', 'Router updated');
    } else {
      setErr((action.payload as string) ?? 'Update failed');
    }
  };

  return (
    <form className="card" onSubmit={onSubmit}>
      <h3 style={{ marginTop: 0 }}>Settings</h3>
      <div className="auth-form">
        <label>
          <span>Label</span>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </label>
        <label>
          <span>MAC address</span>
          <input value={mac} onChange={(e) => setMac(e.target.value)} disabled={busy} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}
    </form>
  );
}

export default function RouterDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const routerId = decodeURIComponent(id);
  const dispatch = useAppDispatch();
  const byId = useAppSelector(selectRoutersById);
  const status = useAppSelector(selectListStatus);
  const listError = useAppSelector(selectListError);
  const lastInstallToken = useAppSelector(selectLastInstallToken);
  const router = byId[routerId];

  // Auto-issue a fresh install token when this router has no token on
  // file, so the user never has to manually click "Rotate install token".
  // We only do this for routers that are NOT online (an online router
  // already has a working agent; silently rotating would invalidate it).
  const liveToken = router
    ? readPersistedInstallToken(router.routerId, lastInstallToken)
    : null;
  const [autoRotating, setAutoRotating] = useState(false);
  const autoRotateDone = useRef(false);

  useEffect(() => {
    if (!router || liveToken || autoRotating) return;
    if (router.status === 'online') return; // agent connected — don't break it
    if (autoRotateDone.current) return;
    autoRotateDone.current = true;
    setAutoRotating(true);
    dispatch(rotateInstallToken(router.routerId))
      .then((action) => {
        if (rotateInstallToken.rejected.match(action)) {
          autoRotateDone.current = false; // let the user retry manually
        }
      })
      .finally(() => setAutoRotating(false));
  }, [router, liveToken, autoRotating, dispatch]);

  useEffect(() => {
    if (status === 'idle') dispatch(fetchRouters());
    const t = window.setInterval(() => dispatch(fetchRouters()), 5_000);
    return () => window.clearInterval(t);
  }, [dispatch, status]);

  if (status === 'failed' && !router) {
    return (
      <div className="card">
        <h2>Router not found</h2>
        <p className="muted">{listError ?? `No router with id "${routerId}"`}</p>
        <Link to="/routers" className="btn">← Back to routers</Link>
      </div>
    );
  }
  if (!router) {
    return <div className="card muted">Loading…</div>;
  }

  // `liveToken` is computed above the hooks (needed by the auto-rotate
  // effect).  It holds a usable install command/token for this router, or
  // null.  When null and the router is not online, we auto-generate a
  // fresh one so the user never has to click "Rotate install token".
  const installHint = liveToken
    ? liveToken.command
    : autoRotating
    ? `# Generating a fresh install token for "${router.routerId}"…\n# (paste this inside the router's SSH session once it appears)`
    : router.status === 'online'
    ? `# This router is already online — an agent is connected, so no\n# install token is required. Use "Rotate install token" only to\n# reinstall with a new binary / server.`
    : `# No install token is on file and one could not be generated\n# automatically. Click "Rotate install token" below to issue one.`;

  return (
    <section>
      <div className="row" style={{ marginBottom: 16 }}>
        <Link to="/routers" className="ghost back-link">← Routers</Link>
        <h2 style={{ margin: 0 }}>{router.name || router.routerId}</h2>
        <span className={`status ${router.status === 'online' ? 'online' : 'offline'}`}>
          {router.status === 'online' ? '● online' : '○ offline'}
        </span>
        <div className="grow" />
        <RebootButton router={router} />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Router info</h3>
        <div className="kv">
          <div>ID</div>           <div><code>{router.routerId}</code></div>
          <div>MAC</div>          <div><code>{router.macAddress}</code></div>
          <div>Model</div>        <div>{router.model || '—'}</div>
          <div>Firmware</div>     <div>{router.firmware || '—'}</div>
          <div>Hostname</div>     <div>{router.hostname || '—'}</div>
          <div>IP</div>           <div>{router.ip || '—'}</div>
          <div>Agent version</div><div>{router.agentVersion || '—'}</div>
          <div>Last seen</div>    <div>{router.lastSeen || 'never'}</div>
          <div>Created</div>      <div>{router.createdAt}</div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Install the agent on this router</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          SSH into the router and run the one-liner below.  The script
          auto-detects the architecture, downloads the agent binary, writes
          its config, and starts the service.  The agent then opens a
          WebSocket back to this portal and flips the router to{' '}
          <strong>● online</strong>.
        </p>
        <p className="muted" style={{ marginTop: 0 }}>
          If no install token is on file, a fresh one is generated
          automatically so you can install the agent right away. The token
          is shown <strong>once</strong>. After the agent has connected,
          rotating the token issues a new one (any previously-installed
          agent will need to be re-installed with the new token).
        </p>
        <CopyableCode value={installHint} />
        {liveToken && (
          <div className="kv" style={{ marginTop: 12 }}>
            <div>Install token</div>
            <div><CopyableCode value={liveToken.token} /></div>
          </div>
        )}
        <p className="dim" style={{ marginTop: 12 }}>
          Install script:{' '}
          <a href={`${PUBLIC_ORIGIN}/install.sh`} target="_blank" rel="noopener noreferrer">
            <code>{PUBLIC_ORIGIN}/install.sh</code>
          </a>
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <RotateTokenButton router={router} busy={autoRotating} />
        </div>
      </div>

      <EditMetaForm router={router} />

      <div className="card">
        <h3 style={{ marginTop: 0, color: 'var(--error)' }}>Danger zone</h3>
        <p className="muted">
          Removing a router unregisters it from your account. The agent on the
          device will be rejected on its next reconnect.
        </p>
        <DeleteRouterButton router={router} />
      </div>
    </section>
  );
}
