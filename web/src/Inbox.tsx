export function Inbox() {
  return (
    <div className="inbox">
      <h3>Signed webhook inbox</h3>
      <p className="lede">
        This page does not call the inbox, and the dev server does not attach its secret. On your machine, run <code>cd web && npm run webhook</code>. It listens on 127.0.0.1 and keeps the secret in <code>web/.webhook/secret</code>. Read it by sending that secret yourself in <code>x-renewpay-inbox</code>.
      </p>
    </div>
  );
}
