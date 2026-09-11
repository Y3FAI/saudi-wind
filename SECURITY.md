# Security

Please report a suspected vulnerability through the repository's private GitHub
security-advisory flow (Security → Advisories → New draft advisory) rather than
a public issue.

Do not include credentials, private Cloudflare identifiers, or user data in a
public report.

## Scope and design

Saudi Wind has no accounts and stores no user information — there is no
database, no login, and no server-side session state.

The public surface is deliberately small:

- Static frontend assets on Cloudflare Pages.
- Two read-only Pages Function endpoints (`/api/wind/latest` and
  `/api/wind/grids/{name}.bin`) that accept only `GET` and `HEAD` and map a
  strictly validated name to a private R2 object. There is no bucket listing,
  no write path, and no arbitrary object access.
- A private R2 bucket that is not exposed through `r2.dev`.

The response layer sets `X-Content-Type-Options: nosniff` and
`Referrer-Policy`, and the deployed site adds a restrictive Content Security
Policy, HSTS, and a permissions policy (`public/_headers`).

Reports most likely to be relevant: bypassing the run-id/grid-name validation,
reaching arbitrary R2 objects, bypassing the `GET`/`HEAD` restriction, or a
caching/header issue that could serve one user's data as another's (there is no
per-user data, so this is largely a caching-correctness question).

## Secrets

Publication credentials live only in GitHub Actions secrets and Cloudflare's
own secret stores. If you believe a credential has leaked, follow the rotation
steps in [docs/OPERATIONS.md](docs/OPERATIONS.md#credential-rotation) and revoke
the old token in Cloudflare.
