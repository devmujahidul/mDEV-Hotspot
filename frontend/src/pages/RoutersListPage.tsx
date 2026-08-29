import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  fetchRouters,
  createRouter,
  selectRouters,
  selectListStatus,
  selectListError,
  selectLastReboot,
  selectLastInstallToken,
  clearLastReboot,
  clearLastInstallToken,
} from '@/features/routers/routersSlice';
import { useToast } from '@/features/ui/useToast';
import { WS_URL, PUBLIC_ORIGIN } from '@/services/api';
import { normalizeMac } from '@/utils/mac';
import { suggestRouterId } from '@/utils/id';
import CopyableCode from '@/components/CopyableCode';
import type { Router } from '@/types';

function StatusPill({ online }: { online: boolean }) {
  return (
    <span className={`status ${online ? 'online' : 'offline'}`}>
      {online ? '● online' : '○ offline'}
    </span>
  );
}

function RebootResultBanner() {
  const last = useAppSelector(selectLastReboot);
  const dispatch = useAppDispatch();
  if (!last) return null;
  return (
    <div
      className={`banner ${last.ok ? 'success' : 'error'}`}
      role="alert"
      onClick={() => dispatch(clearLastReboot())}
    >
      <strong>{last.ok ? '✅ Reboot sent' : '❌ Reboot failed'}</strong>{' '}
      <span className="muted">({last.routerId}):</span> {last.message}
    </div>
  );
}

function InstallTokenPanel() {
  const t = useAppSelector(selectLastInstallToken);
  const dispatch = useAppDispatch();
  if (!t) return null;

  // The backend's `installCommand` is already a fully baked curl | sh
  // one-liner (it contains the install token).  We display it as the
  // primary install instruction.  We also show the raw install.sh URL
  // so the user can preview it in a browser.  The URL is built from
  // PUBLIC_ORIGIN (not API_BASE) because install.sh is mounted at the
  // app root, not under /api.
  const installScriptUrl = `${PUBLIC_ORIGIN}/install.sh`;

  // Defensive: even with slice-level validation, never render `undefined`
  // in the panel — it would render as the literal string "undefined" and
  // confuse the user.  If the record is missing command or token (which
  // can only happen if localStorage was hand-edited or stored a partial
  // record by a much older build of the app), show a "rotate to refresh"
  // hint instead of a broken curl one-liner.
  const command = typeof t.command === 'string' && t.command.length > 0 ? t.command : null;
  const token   = typeof t.token   === 'string' && t.token.length   > 0 ? t.token   : null;
  const partial = !command || !token;
  const hasRouter = typeof t.routerId === 'string' && t.routerId.length > 0;
  const routerIdLabel = hasRouter ? t.routerId : '(unknown)';

  return (
    <div className="card install-token">
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Install the agent on &ldquo;{routerIdLabel}&rdquo;</h3>
        <div className="grow" />
        {hasRouter && (
          <Link
            to={`/routers/${encodeURIComponent(t.routerId)}`}
            className="ghost"
          >
            View router
          </Link>
        )}
        <button className="ghost" onClick={() => dispatch(clearLastInstallToken())}>
          Dismiss
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        A new install token was just generated. It is shown <strong>once</strong>{' '}
        and is already embedded in the command below. SSH into your OpenWrt/Linux
        router and paste the command — the script will auto-detect the
        architecture, download the right agent binary, write its config, and
        start the service.
      </p>
      <div className="kv">
        <div>Install script</div>
        <div>
          <a href={installScriptUrl} target="_blank" rel="noopener noreferrer">
            <code>{installScriptUrl}</code>
          </a>{' '}
          <span className="dim">(you can preview it in a browser)</span>
        </div>
        <div>Command</div>
        <div>
          {command ? (
            <CopyableCode value={command} />
          ) : (
            <span className="muted">
              <code>&lt;INSTALL_TOKEN&gt;</code> — rotate on the detail page to
              issue a fresh one-liner.
            </span>
          )}
        </div>
        <div>Token</div>
        <div>
          {token ? (
            <CopyableCode value={token} />
          ) : (
            <span className="muted">(not available in this session — rotate to issue a new one)</span>
          )}
        </div>
        <div>WebSocket</div>
        <div><code>{WS_URL}</code></div>
        {partial && (
          <div className="muted" style={{ gridColumn: '1 / -1', marginTop: 4 }}>
            ℹ️ This entry was rehydrated from localStorage without a complete
            command/token payload (likely from a stale entry written by an older
            build of the app). Rotating the token on the router&apos;s detail
            page will replace it with a working one-liner.
          </div>
        )}
      </div>
    </div>
  );
}

function AddRouterForm({ onCreated }: { onCreated: () => void }) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [routerId, setRouterId] = useState(() => suggestRouterId());
  const [routerIdDirty, setRouterIdDirty] = useState(false);
  const [name, setName] = useState('');
  const [mac, setMac] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openForm = () => {
    setRouterId(suggestRouterId());
    setRouterIdDirty(false);
    setName('');
    setMac('');
    setErr(null);
    setOpen(true);
  };
  const reroll = () => {
    setRouterId(suggestRouterId());
    setRouterIdDirty(false);
  };

  if (!open) {
    return <button onClick={openForm}>+ Add router</button>;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);

    const rid = routerId.trim();
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(rid)) {
      setErr('Router ID must be 2-40 chars: letters, digits, "-" or "_"');
      return;
    }
    const normalized = normalizeMac(mac);
    if (!normalized) {
      setErr(
        'Invalid MAC address. Accepted forms: aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, aabb.ccdd.eeff, aabbccddeeff'
      );
      return;
    }

    setBusy(true);
    const action = await dispatch(
      createRouter({
        routerId: rid,
        name: name.trim() || undefined,
        macAddress: normalized,
      })
    );
    setBusy(false);

    if (createRouter.fulfilled.match(action)) {
      toast('success', `Router ${action.payload.routerId} added`);
      setOpen(false);
      setRouterId(suggestRouterId());
      setRouterIdDirty(false);
      setName('');
      setMac('');
      onCreated();
    } else {
      // If the auto-suggested id was already taken, re-roll and surface
      // the error.  This keeps the form one click away from a fresh id.
      const msg = (action.payload as string) ?? 'Failed to add router';
      setErr(msg);
      if (!routerIdDirty && /already|conflict|exists|taken|router id/i.test(msg)) {
        reroll();
      }
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Add a router</h3>
        <div className="grow" />
        <button
          type="button"
          className="ghost"
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          Cancel
        </button>
      </div>

      <div className="auth-form">
        <label>
          <span>
            Router ID <span className="dim">(auto-generated, editable)</span>
          </span>
          <div className="row" style={{ gap: 8 }}>
            <input
              value={routerId}
              onChange={(e) => {
                setRouterId(e.target.value);
                setRouterIdDirty(true);
              }}
              disabled={busy}
              placeholder="router-7h2k"
              required
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="ghost"
              onClick={reroll}
              disabled={busy}
              title="Generate a new router ID"
              aria-label="Generate a new router ID"
            >
              ↻
            </button>
          </div>
        </label>
        <label>
          <span>
            Label <span className="dim">(optional)</span>
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="Cafe lobby router"
          />
        </label>
        <label>
          <span>
            MAC address <span className="dim">(br-lan / WAN of the router)</span>
          </span>
          <input
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            disabled={busy}
            placeholder="aa:bb:cc:dd:ee:ff"
            spellCheck={false}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create router'}
        </button>
      </div>

      {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}
    </form>
  );
}

export default function RoutersListPage() {
  const dispatch = useAppDispatch();
  const routers = useAppSelector(selectRouters);
  const status = useAppSelector(selectListStatus);
  const listError = useAppSelector(selectListError);

  useEffect(() => {
    dispatch(fetchRouters());
    const t = window.setInterval(() => dispatch(fetchRouters()), 5_000);
    return () => window.clearInterval(t);
  }, [dispatch]);

  const onRefresh = () => dispatch(fetchRouters());

  return (
    <section>
      <div className="row" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Routers</h2>
        <span className="muted">
          {routers.length} registered ·{' '}
          {routers.filter((r) => r.status === 'online').length} online
        </span>
        <div className="grow" />
        <button className="ghost" onClick={onRefresh} disabled={status === 'loading'}>
          {status === 'loading' ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <RebootResultBanner />
      <InstallTokenPanel />

      {listError && (
        <div className="banner error">Error loading routers: {listError}</div>
      )}

      <AddRouterForm onCreated={() => undefined} />

      {routers.length === 0 && status === 'succeeded' && (
        <div className="empty card">
          You haven&apos;t added any routers yet. Click <strong>Add router</strong>{' '}
          above to register your first one.
        </div>
      )}

      <div className="router-grid">
        {routers.map((r: Router) => (
          <Link
            key={r.routerId}
            to={`/routers/${encodeURIComponent(r.routerId)}`}
            className="card router-card"
          >
            <div className="row" style={{ marginBottom: 8 }}>
              <div className="grow">
                <strong>{r.name || r.routerId}</strong>
                <div className="muted">{r.routerId}</div>
              </div>
              <StatusPill online={r.status === 'online'} />
            </div>
            <div className="kv">
              <div>Model</div>
              <div>{r.model || '—'}</div>
              <div>Firmware</div>
              <div>{r.firmware || '—'}</div>
              <div>MAC</div>
              <div>
                <code>{r.macAddress}</code>
              </div>
              <div>Last seen</div>
              <div>{r.lastSeen || 'never'}</div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
