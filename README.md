# Sumaya Atelier API — standalone server

A long-running Node/Express service backing the collection CMS: Postgres via
Prisma, Cloudinary for photography, JWT auth for the atelier's admin accounts.
It replaces the Vercel functions in `../sumaya/api` with a process you can run
anywhere Node runs — a VPS, a container, `npm start` on a laptop.

The API surface is unchanged. The SPA keeps calling the same paths with the same
bodies and the same error envelope; only the origin moves.

## What is different from the serverless version

| | Serverless (`../sumaya/api`) | This server |
|---|---|---|
| Runtime | One invocation per request | One process, many requests |
| Database | Neon over WebSockets, a client per cold start | `pg` pool held open for the process's life |
| Routing | One file per endpoint, by path convention | Express routers, declared with `mount()` |
| Lifecycle | The platform's | `/health`, `/ready`, and graceful shutdown on SIGTERM |
| Storage / mail | Cloudinary, Resend | Same, plus in-memory drivers for tests and offline work |
| Body limits | 4.5MB platform cap | 8MB uploads, 256kb JSON, both ours to change |

The business rules did not move an inch: `AuthService`, `PieceService` and
`ImageService` are the same code, because they never knew what was in front of
them. That is what made this port a transport change rather than a rewrite.

## Layout

```
src/
  server.ts        listen, signals, graceful shutdown
  app.ts           the middleware chain, in the order it runs
  routes/          transport only — declare method, auth, schema, limits
  http/            route wrapper, errors, cookies, rate limiting, multipart
  auth/            AuthService, sessions, tokens, passwords
  pieces/          PieceService, ImageService, repository, serialisers
  storage/ mail/   the two swappable seams, and their drivers
  config/env.ts    every environment variable, validated at boot
  db/              Prisma client and the generated types
tests/             the suite described below
prisma/            schema, migrations, seed
```

The rule that keeps this navigable: **routes declare, services decide.** A route
names its method, auth requirement, schemas and rate limits, then calls a
service. Everything cross-cutting — CORS, security headers, request ids, auth,
rate limiting, error mapping — happens in `http/route.ts` and `http/middleware.ts`,
so a route cannot forget it.

## Getting started

```bash
cp .env.example .env          # then fill it in — see the comments in that file
npm install                   # postinstall runs `prisma generate`
npm run db:migrate            # creates the schema
npm run db:seed               # 4 categories + the first superadmin
npm run dev                   # tsx watch, on PORT (default 4000)
```

No Postgres to hand? `docker compose up --build` brings up both, or point
`DATABASE_URL` at any Postgres you already have.

Generate the two JWT secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Leave `RESEND_API_KEY` empty in development and password-reset links print to the
console instead of being emailed. Production refuses to start without it — along
with Cloudinary credentials and rate limiting, all checked in `config/env.ts`
before the port is bound.

Once you have signed in and changed the seeded password, delete
`SUPERADMIN_PASSWORD` from `.env`.

## Endpoints

Identical to the serverless API, under `/api`.

### Auth

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | — | Access token in the body, refresh token in an httpOnly cookie |
| POST | `/api/auth/refresh` | cookie | Rotates the refresh token; replaying an old one revokes the whole family |
| POST | `/api/auth/logout` | cookie | Always 200, even with no session |
| GET | `/api/auth/me` | bearer | Re-reads the account, so a disabled user is rejected |
| POST | `/api/auth/forgot-password` | — | Always 202, identical body whether or not the account exists |
| POST | `/api/auth/reset-password` | reset token | Single-use, 30 min; revokes every session |
| POST | `/api/auth/change-password` | bearer | Requires the current password; signs other devices out |

### Catalogue

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/pieces` | optional | Public sees `PUBLISHED` only; admin sees drafts and the admin shape |
| POST | `/api/pieces` | bearer | Create |
| GET | `/api/pieces/:id` | optional | `:id` is the uuid **or** the slug (`ring-001`) |
| PATCH | `/api/pieces/:id` | bearer | Partial update; empty body is rejected |
| DELETE | `/api/pieces/:id` | bearer | Soft delete. `?purge=true` also destroys the Cloudinary assets |
| POST | `/api/pieces/:id/images` | bearer | `multipart/form-data`, field `file`, plus `kind` and `alt` |
| PATCH | `/api/pieces/:id/images/reorder` | bearer | Send the **whole** gallery, not a delta |
| DELETE | `/api/images/:imageId` | bearer | Removes the row and the stored asset |
| GET | `/api/categories` | optional | `{ id, label, singular, count }` |
| GET | `/api/stones` | optional | Filter facet: `{ slug, name, count }`, `?category=` scopes the counts |

### Contact

Both are public, unauthenticated, and answer `202` for anything they accepted —
including a submission dropped as spam, so a bot learns nothing from the reply.
Each carries a honeypot field (`website`) and is rate limited per IP *and* per
address. Mail goes to `CONTACT_TO` with the visitor set as the reply-to.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/contact` | none | Enquiry form: `name`, `email`, `message`, optional `phone` and `subject` |
| POST | `/api/contact/newsletter` | none | Newsletter signup: `email`. Forwarded, not stored |

### Operations

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness. Touches nothing — restart the process if it fails |
| GET | `/ready` | Readiness. Queries the database; 503 means stop routing traffic here |

`GET /api/pieces` accepts `?category=`, repeatable `?stone=`, `?featured=`,
`?search=`, `?page=`, `?perPage=` (max 100), and — for authenticated callers —
`?status=`. A public caller passing `?status=DRAFT` still gets published pieces;
the filter is simply not theirs to set.

Public piece responses are the `Piece` shape `src/content/pieces.ts` already
exports in the frontend — `{ id, name, category, stones, metal, story, studio[],
model[], featured }` — so the React components can swap a static import for a
fetch without a prop change.

## Errors

Every failure returns the same envelope:

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "…", "details": null, "requestId": "…" } }
```

Branch on `code`, never on `message`. The vocabulary is in `src/http/errors.ts`.
A 500 returns only a `requestId`, which is also on the `x-request-id` header and
on every log line for that request.

## Security notes

- **Passwords** — bcrypt cost 12. Inputs over 72 bytes are rejected rather than
  silently truncated, which is what bcrypt would otherwise do.
- **Access tokens** — HS256, 15 minutes, `algorithms` pinned on verify. They
  carry `pwdAt`; changing a password bumps `passwordChangedAt` and every earlier
  token stops verifying.
- **Refresh tokens** — 32 random bytes, stored only as a sha256, in an
  `httpOnly; SameSite=Strict` cookie scoped to `/api/auth`. Rotated on every
  use; a replayed token revokes its whole lineage.
- **No enumeration** — login and forgot-password answer identically, and in
  comparable time, whether or not the address has an account.
- **Lockout** — 5 consecutive failures locks the account for 15 minutes.
- **Rate limits** — counted in Postgres rather than in memory, so the limit
  means the same thing behind a load balancer as it does on one box. Login
  10/15min, forgot-password 3/hr per address, mutations 60/min, public reads
  300/min. The limiter fails *open* if the database is unreachable: login
  staying up matters more than a perfectly enforced counter.
- **Uploads** — type is decided by magic bytes, not the declared `Content-Type`.
  8MB per file, 40 images per piece.
- **CORS** — the origin is reflected only when it is on the `CORS_ORIGINS`
  allowlist, which is what makes `Allow-Credentials` safe.
- **Proxies** — `TRUST_PROXY` is off by default. Turn it on only behind a proxy
  that overwrites `x-forwarded-for`; otherwise any caller can spoof the address
  their rate limit is counted against.

## Tests

```bash
npm test          # the suite: 115 tests, no external services
npm run typecheck
npm run smoke     # after `npm run build` — boots dist/server.js for real
```

The suite runs against **real Postgres**: PGlite (Postgres compiled to
WebAssembly) is started in-process and fronted by a socket server, so the
application connects with the same `pg` driver, the same Prisma adapter and the
same SQL it uses in production. The schema comes from `prisma/migrations`, so
what is tested is the DDL that will actually be deployed.

That choice is the point. A stubbed repository layer would accept queries a real
database rejects, and the invariants worth protecting here — the featured-piece
transaction, the rate-limit upsert, the cascade on delete, the dense image
ordering — are exactly the ones only a real engine gets right.

The only substitutes are the two seams the production code already had:
`STORAGE_DRIVER=memory` keeps uploads in a map, and `MAIL_DRIVER=memory` keeps
sent mail in an outbox the tests read the way a recipient would.

| File | Covers |
|---|---|
| `tests/app.test.ts` | Security headers, CORS allowlist, 404/405, request ids, cache policy |
| `tests/auth.test.ts` | Login, lockout, enumeration, refresh rotation and reuse detection, reset and change flows |
| `tests/pieces.test.ts` | Public vs admin shapes, filters, paging, slugs, the featured-piece rule, soft delete and purge |
| `tests/images.test.ts` | Upload, magic-byte rejection, reorder, delete and gap closing, asset cleanup |
| `tests/categories.test.ts` | Taxonomy and live counts |
| `tests/stones.test.ts` | Stone facet, category scoping, and the slug round trip into `?stone=` |
| `tests/rate-limit.test.ts` | Windows, per-identifier counting, `Retry-After`, pruning, a real 429 |
| `tests/unit.test.ts` | Passwords, tokens, image sniffing, slugs, the environment contract |

`npm run smoke` is the one thing the suite cannot cover: it builds, boots
`dist/server.js` as a process against a throwaway database, drives it over HTTP,
and checks it shuts down when signalled.

## Deploying

```bash
npm ci
npm run build
npm run db:deploy     # apply migrations
npm start
```

Or `docker build -t sumaya-api .` — the image runs `prisma migrate deploy` and
then the server, as a non-root user, with a healthcheck on `/health`.

Behind a reverse proxy, set `TRUST_PROXY=true` and terminate TLS there. Point the
SPA at the server's origin and add that origin to `CORS_ORIGINS`; the refresh
cookie needs `credentials: "include"` on the SPA's fetches, which is why the
allowlist — not a wildcard — is what makes it work.

## Verifying a change

```bash
npm run typecheck
npm test
npm run build && npm run smoke
```

After touching auth, the manual pass still worth running: sign in → wrong
password six times → confirm `ACCOUNT_LOCKED` → refresh → replay the old refresh
token and confirm the family is revoked in `npm run db:studio`.
