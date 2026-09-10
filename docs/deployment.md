# Deployment

Self-hosted on a VPS: PM2 for the process, nginx in front, PostgreSQL local.
No managed platform, matching the rest of the estate.

## Build and start

```bash
git pull

cd backend
npm ci
npx prisma db push          # then `prisma generate` if the client is stale
npm run build               # tsup → dist/server.js

cd ../frontend
npm ci
npm run build               # vue-tsc + vite → frontend/dist

cd ..
pm2 start ecosystem.config.cjs
pm2 save
```

The backend serves `frontend/dist` when it exists, so there is one origin and
no CORS in production. **It checks at boot**, so build the frontend before
starting the API — otherwise the static mount is skipped and `/` 404s until
the next restart.

## PM2

`ecosystem.config.cjs` runs **one instance in fork mode**. Both parts matter:

- Only one process may hold the WhatsApp session. Two copies against the same
  session directory knock each other offline in a loop.
- Cluster mode plus bundled bcryptjs produced intermittent auth failures on
  sibling projects. Fork mode and externalised natives is the fix.

`wait_ready` with `process.send('ready')` keeps zero-downtime reloads
available. `kill_timeout: 8000` gives the socket time to close cleanly.

## nginx

```nginx
server {
  listen 443 ssl http2;
  server_name tapis.example.com;

  client_max_body_size 5M;
  gzip on;
  gzip_types application/json text/css application/javascript image/svg+xml;

  location / {
    proxy_pass http://127.0.0.1:3140;
    proxy_http_version 1.1;              # keepalive to the upstream
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;             # the analysis model can be slow
  }
}
```

Give the server a `default_server` block that refuses unknown hosts. A box
without one serves whichever site nginx loaded first to every new subdomain,
which has bitten this estate before.

## Files that must never be served

The code never serves them; keep it that way if you add a static mount.

| Path | Why |
|---|---|
| `backend/.wa-session/` | a complete WhatsApp login |
| `backend/.credential-key` | decrypts stored API keys |
| `backend/media/` | client media, exposed only through an authenticated route |

`WA_SESSION_DIR` is **ignored in production** on purpose. It exists so tests
can point at a disposable directory, and an environment variable that can move
the session is one that can move it under a served directory.

## Environment

Production refuses to boot with a missing or example `JWT_SECRET`. Everything
else has a default or can be set on the Settings screen.

```
DATABASE_URL=postgresql://tapis:…@localhost:5432/tapis
PORT=3140
JWT_SECRET=<64 hex chars>
NODE_ENV=production
CREDENTIAL_KEY=<optional; else a 0600 .credential-key is generated>
```

## After deploying

1. Sign in, open **WhatsApp link**, confirm `connected` and the account name.
2. If the chat list looks thin, that is the history sync: it only runs at
   pairing. See [whatsapp.md](whatsapp.md).
3. Check the bell. It reports a missing key, the mock provider, a link that
   needs a person, failed runs, and tracked chats with no rules.
4. Watch `pm2 logs tapis` through one pipeline run.

## Backups

`pg_dump` the database. It holds the client messages, so treat the dump as
confidential — and note that stored API keys are encrypted inside it, which
is the entire reason they are encrypted at rest.

The session directory is **not** backed up. Restoring one elsewhere means two
processes with the same credentials fighting; re-pair instead.

## Upgrading

Run `prisma db push` before starting the new build. `migrate deploy` does not
run `generate`; `db push` is what this project uses.

Restarting is safe at any time — the link resumes from the saved session. But
a restart **does not replay the history sync**, so never restart while the
initial sync is streaming after a fresh pairing.
