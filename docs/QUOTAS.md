# Infrastructure quotas

Verified against the provider documentation on 28 July 2026.

## Cloudflare Pages and Functions

The Cloudflare Pages Free plan currently allows 500 builds per month, 20,000
files per site, a 25 MiB maximum individual asset, and unlimited preview
deployments. Saudi Wind has fewer than 40 deployed files and its largest
application asset is below 300 KiB.

Pages Function requests count against the Workers Free plan. The current free
allowance is 100,000 requests per day with 10 ms of CPU per invocation.
Static Pages assets do not consume that request allowance. A new uncached
Saudi Wind visit normally invokes the Function twice: once for the manifest
and once for its immutable grid. A running tab revalidates only the manifest
every 15 minutes.

Sources:

- [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

## R2

The R2 Standard free tier currently includes 10 GB-month of storage, one
million Class A operations, ten million Class B operations, and free egress.
The lifecycle retains approximately 120 six-hour GFS grids. At 58,200 bytes
per current grid, that is roughly 7 MB before small metadata overhead—well
below one percent of the storage allowance.

Source: [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## GitHub Actions

The repository is public and uses standard `ubuntu-latest` runners. GitHub
currently provides these runners free of charge for public repositories. The
ingestion workflow checks hourly, the production health monitor checks every
six hours, and CI runs for pull requests and `main`.

Source:
[GitHub Actions billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage).

## Monitoring and alerts

- `Monitor production wind` validates freshness, manifest identity, grid
  length, and SHA-256 every six hours. A failure appears in GitHub Actions and
  uses normal workflow-failure notifications.
- `Ingest NOAA wind` emits an Actions warning and exits safely when its R2
  credentials have not been configured.
- R2 per-bucket operations and storage remain available in the Cloudflare
  dashboard for the previous 31 days.
- Cloudflare pay-as-you-go budget alerts and GitHub account budgets are
  billing-owner choices. The release does not create or change a spending
  limit without the account owner selecting an amount.

Sources:

- [R2 metrics and analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
- [GitHub budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts)
