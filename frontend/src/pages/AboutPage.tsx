
export default function AboutPage() {
  return (
    <section>
      <h2 style={{ marginTop: 0 }}>About mDEV Hotspot</h2>
      <div className="card">
        <p>
          <strong>mDEV Hotspot Manager</strong> is a web platform for managing
          fleets of OpenWrt routers remotely. Each router runs a small C agent
          (<code>mDEV_agent</code>) that connects to the backend over
          WebSocket and executes commands (reboot, etc.) sent from this
          dashboard.
        </p>
        <p>
          This is a multi-user SaaS: every user has their own account, owns
          their own routers, and only sees their own data. Authentication is
          done with per-user <strong>email + password</strong> signed JWTs;
          every router is registered in the database before the agent is
          allowed to connect, and each install token is rotated per-router.
        </p>
        <h3>Roadmap</h3>
        <ul>
          <li>Voucher / hotspot-portal generation (Chillispot / CoovaChilli)</li>
          <li>Live bandwidth &amp; session graphs</li>
          <li>OTA firmware updates</li>
          <li>Multi-tenant billing &amp; reseller plans</li>
        </ul>
      </div>
    </section>
  );
}
