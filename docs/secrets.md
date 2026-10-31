# Secrets (issue #7, D-008, D-021)

Status: implemented in source on `claude/issue-7-07-openbao-credentials`; independent review pending. Not deployed. Authenticated retrieval from the real OpenBao is **not** live-verified: no scoped read-only identity exists yet (see "Homeowner actions").

## Inventory of OpenBao on Tower (read-only, 2026-10-30)
OpenBao 2.6.1 runs as the `openbao` container (image `openbao/openbao:2.6.1`, network `openbao_openbao`, port 8200 published on all interfaces), initialised and unsealed; `GET /v1/sys/health` (unauthenticated) answers. Its config, data, file, keys and logs are bind mounts. No root, unseal or other token was read, and no policy or auth role was inspected or changed. Which auth method and role the existing deployment uses for other tools was not looked up: that needs a token, and the broker deliberately does not use a broad one.

## Delivery (answers OQ-1)
The trusted host-side broker (`broker/`) is the only code that talks to OpenBao. A run that needs secrets lists names in its spec (`secrets: ["fixture-login"]`):

1. The broker checks every name against the policy (`broker/policy.example.json` shape: path, kind, domain allow-list, max TTL), then checks with `sys/capabilities-self` that the identity can read the path and **cannot** create, update, delete, sudo or is root.
2. Each secret is written to `/dev/shm/devtest-secrets/<run-id>/<name>` (tmpfs: memory only, never the cache pool), directory 0700, file 0400 owned by the container user, created exclusively.
3. The runner re-verifies (regular file, not a symlink, one link, 0400-class mode, private directory) and bind-mounts it **read-only** at `/secrets/<name>`. The container keeps `--network=none`, so a secret cannot leave except through a declared target.
4. After the run (success, failure or exception) the files are overwritten with zeros, deleted, the directory removed and any lease revoked. The output directory is then scanned for every secret value in raw, base64, URL-encoded and JSON-escaped form; every non-empty value is scanned, however short (a tiny value can match ordinary output; that fails closed, so use a real credential). Session state (cookies, localStorage, sessionStorage) follows one rule, because it also holds non-secret flags such as `1`: a value is scanned if its storage key looks like a credential (case-insensitive match on `token`, `auth`, `session`, `sid`, `jwt`, `key`, `pass`, `secret`, `cred` or `bearer`), at any length; otherwise it is scanned when it is four or more characters long, and skipped when it is shorter. The literals `true` and `false` under a non-credential key are treated as flags and skipped, since they would match almost any JSON output; under a credential-like key they are scanned like anything else. A hit makes the run fail with exit 8 and the contaminated output files are overwritten and deleted by the broker; the error says how many were discarded, and any it could not remove must be deleted by hand.

Rejected: environment variables (visible in `docker inspect` and `/proc`), command-line arguments (D-008), files under the repository or the cache pool, a container-side OpenBao client (would need a network route and a token inside untrusted code).

The OpenBao token is read from an owner-only file (mode 0600, regular file, not a symlink), never from argv or the container environment, sent only in a header, and requests refuse redirects. Addresses must be https, or http on loopback.

## Sessions
A `session` secret holds a Playwright `storage_state`. Before it is written, `broker/session.mjs` keeps only cookies whose domain matches the allow-list, drops expired ones and session cookies with no expiry, and caps every expiry at the policy TTL. Origins outside the allow-list are dropped. An empty result is refused. Cookies are never exported: reports do not carry them, the summary holds counts only, and **traces are refused** on a run with secrets (a trace keeps request headers and DOM, and a compressed archive cannot be scanned).

## Dry-run backend
When OpenBao is unavailable use `createMockBackend()` (`broker/mock.mjs`): random per-call values prefixed `MOCK-NOT-A-SECRET-`, valid nowhere. It never requests or invents a real credential. `handle.dryRun` is true so a result can say so.

## Live Home Assistant
Entries marked `production` are refused unless the policy has `productionIdentity.confirmed: true` with a decision id, that decision is `homeowner-approved` in `docs/DECISIONS.md` (an agent proposal, an unknown id or an unreadable register refuses), **and** the entry's identity starts with `devtest-`. The shipped example keeps `confirmed: false`. Setting it needs a dated homeowner decision after a dedicated least-privilege test identity exists; nothing here logs in to Home Assistant.

## Homeowner actions needed (not done by an agent)
- Create a dedicated read-only OpenBao policy and token (or AppRole) limited to `kv/data/devtest/*` read, and place the token in the file named by `openbao.tokenFile` (0600). Then run the live retrieval check.
- Create a dedicated least-privilege Home Assistant test user before any production login is considered.

## Evidence
`tests/broker.test.mjs` (real HTTP fake of the OpenBao API surface: token only in header, wrong token, writable identity, missing secret, unsafe token file, redirect, expired and foreign-domain sessions, leak scan in four encodings, cleanup, isolation, runner verification). `tests/broker-smoke.mjs` (Tower, real Docker, mock backend, unauthenticated live health probe): the container reads the secret, cannot write or remove it, finds it in neither environment nor argv, a deliberate copy into `/out` is caught, secret directories and mounts return to baseline.
