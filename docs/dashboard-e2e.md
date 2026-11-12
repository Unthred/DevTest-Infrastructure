# Dashboard browser checks

`npm run test:e2e:dashboard` is the Tower-only browser check for the dashboard.
It serves only synthetic fixture state, then uses the digest-pinned official Playwright
image through the trusted runner. The run has no network route, CPU, memory and PID
limits, and its containers and temporary volumes are removed on every outcome.

Run the cache preparation once after the pinned package version changes:

```sh
node browser/prepare-cache.mjs
ionice -c 3 nice -n 19 npm run test:e2e:dashboard
```

The command covers fixture figures and inbox approval controls, a rendered action
decision, the Work queue and its pagination, empty overview and Work states, and a
malformed fixture error page. It never reads live Foreman state. It is a required
local check rather than a hosted-CI job because Docker-dependent checks run on Tower
only (D-028).
