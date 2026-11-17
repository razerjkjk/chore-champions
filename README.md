# Chore Champions — host-ready public edition

A kids' chore game: kids tap "did it" on chores to earn points, race each
other head-to-head, fight a weekly Monster Boss together, open loot chests,
and redeem points for prizes — while a grown-up checks every chore and
controls the board behind a PIN.

This is a standalone, host-ready copy of the app. It runs on any host that
can run [Bun](https://bun.sh) with a SQLite file — no Muse/Hatch runtime,
no proprietary SDK.

**Everyone gets their own account.** Sign up with an email and password
and your kids, chores, points, hearts, PIN, and prizes belong to you and
only you — another account can't see, edit, or delete them. Every new
account starts with the same 26 starter chores and 8 starter rewards and
zero players, zero points, and no PIN. There is no admin panel and no
moderation — accounts and per-account data are the whole story.

## The theme (original — no licensed characters)

A blocky digging-adventure world with an original cast, so any family can
use it and share it freely:

- **Ranks:** Sprout Scout → Pebble Miner → Copper Crafter → Silver
  Seeker → Gold Gatherer → Gem Hunter → Crystal Champion
- **Weekly champion:** Star Champion, crowned each Monday
- **Monster Bosses:** King Grumbler, Mud Brute, Bone Baron, Ember Dragon,
  Giant Goo King, Cave Crawler Queen (rotating weekly, with taunts)
- **Hearts:** each kid has 5 grumbler hearts. A day without ALL daily
  chores done costs a heart overnight (the **Grumbler Attack** banner);
  hearts come back from quests and perfect days. At 0 hearts a kid is
  knocked out until they finish a **Rally Quest** (3 chores), back with
  3 hearts.
- **Chests:** Wooden / MAGIC / CRYSTAL; **skins** include Starter Scout,
  Shadow Ninja, Ocean Captain, Gem Hero, Stone Guardian, Ember Dragon
  Rider, Mystic Wizard, and Crystal Champion.

## How the game works

- **Mission board:** daily, weekly, and one-time chores. A kid taps "did
  it" — the chore goes to **"Waiting for a parent to check it"** and its
  points are held until a grown-up verifies it in the Grown-Up Zone
  ("Yes, they did it" awards the points; "Not done" sends it back open).
  A chore waiting for verification counts as done for the hearts rule.
- **Head-to-head race:** weekly points side by side, with a race bar and
  a Star Champion crowned each Monday.
- **Prize Shop:** kids spend points on rewards; every redemption needs a
  grown-up's approval (declines refund automatically).
- **Weekly Monster Boss:** the kids' combined weekly points are the
  damage. Beat the boss before Monday and both win +50 points and a
  CRYSTAL chest.
- **Loot chests & combos:** missions randomly drop chests, quest
  completion always drops a MAGIC chest; tapping a chest bursts it open
  for bonus points with confetti. Fast tapping builds a combo meter.
- **Motivation quests:** a welcome quest, a comeback quest when a kid is
  40+ points behind, a streak-save quest, and the Rally Quest for knocked
  out players.
- **Grown-Up Zone (PIN-locked):** a 4-digit parent PIN, created in-app on
  first open, plus a recovery phrase. 5 wrong tries lock the pad for 60
  seconds; it re-locks after 3 quiet minutes, on app close/hide, or via
  Lock now. The server refuses every grown-up action without a live PIN
  session. Inside: verify chores, points off for not listening (pick
  5 / 10 / 15 / 20 points — weekly points only, never below zero, and the
  activity shows the amount actually taken), add/remove chores (removing
  asks for a confirm tap first), add/edit players, edit missions and
  rewards, and approve prizes.
- **Living background:** a full-bleed blocky world scene with drifting
  clouds, flickering torches, glowing lava, rising embers, and fireflies
  (respects reduced-motion).
- **Daily reset:** the server settles each account's finished days every
  15 minutes (grumbler check, weekly crowns, stale quests, fresh
  motivation quests); the same housekeeping also runs when the board
  loads, so the game is correct even if the timer never fires.

No texting: verification happens in the Grown-Up Zone on the device.
There is no SMS, no email verification, and no password reset yet.

## What starts in the database

Nothing but the starter board — no players, no scores, no PIN:

- 26 starter chores (16 core + 10 extra: wipe counters, empty bathroom
  trash, dust, mop, match & fold socks, get the mail, water plants, sweep
  the porch, pick up sticks, wipe patio furniture)
- 8 starter rewards (stay up late, pick the movie, extra screen time,
  choose dinner, ice cream trip, small toy/treat, special outing, pick a
  family activity)

The family adds their own kids on first setup (Grown-Up Zone → Players →
Add a kid) and creates their PIN the first time they open the zone.

## Run it locally

```sh
bun install
bun run build
bun run start   # listens on http://localhost:3000
```

The server creates the SQLite database and applies `drizzle/`
migrations on startup. Default database path is `./data/app.db`.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. Railway and Render set this themselves. |
| `DATABASE_PATH` | `./data/app.db` | SQLite file. **Put it on a persistent volume** (see below) or every family's game disappears when the container is replaced. |
| `CLIENT_DIR` | `dist/client` | Built client directory. |
| `MIGRATIONS_DIR` | `drizzle/` | Drizzle migration files. |
| `SESSION_COOKIE_SECURE` | _(unset)_ | Set to `1` when the app is served over HTTPS so the session cookie is only sent over secure connections. Leave unset for plain-HTTP local runs. |
| `APP_URL` | `http://localhost:3000` | Public URL of the app. Forgot-password emails link back here. |
| `RESEND_API_KEY` | _(unset)_ | Resend API key for forgot-password emails. Without it the reset flow still answers, but no email goes out. |
| `RESEND_FROM` | _(unset)_ | Sender address for reset emails, e.g. `Chore Champions <noreply@yourdomain.com>`. Resend only delivers to arbitrary recipients from a **verified domain**; until a domain is verified, mail only reaches the account owner's own address. |

Forgot-password: the sign-in screen has a "Forgot password?" link. A reset link is single-use, good for 1 hour, and is emailed through Resend (see the rows above). Set `APP_URL` to the live site URL or the emailed link points at localhost.

Endpoints: `GET /` (the app), `GET /health` (returns `{"ok":true}` —
use it as the host health check), `POST /actions` (`{action, args}`).

## Deploy

### Option A — Railway (easiest, no Docker)

1. Put this folder in a GitHub repo and push it.
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
   Railway auto-detects Bun from `bun.lock` and builds with Railpack.
   Do not put a file named `Dockerfile` in the repo root — Railway
   picks it up and its validator rejects this image; the Docker file
   lives at `Dockerfile.render` for Render and local Docker use.
3. Set the service commands explicitly if they are not picked up:
   **Build Command** `bun run build`, **Start Command** `bun run start`.
4. Add a **Volume**, mount path `/app/data`. (Volumes need a paid plan.)
5. Variables: `DATABASE_PATH=/app/data/app.db`. `PORT` is provided by
   Railway — do not set it yourself. Set `SESSION_COOKIE_SECURE=1`
   (the site is served over HTTPS).
6. Deploy. Open the generated domain; `/health` should return `{"ok":true}`.

### Option B — Render (Docker)

1. Push this folder to a GitHub repo.
2. Render → **New → Web Service → Build and deploy from a Git repository** →
   pick the repo → **Runtime: Docker**, Dockerfile path `Dockerfile.render`.
   The included `Dockerfile.render` does the rest (`bun install`,
   `bun run build`, `bun run start`).
3. Add a **Persistent Disk**, mount path `/app/data`, 1 GB. (Disks need a
   paid instance type; on the free tier the database lives on ephemeral
   disk and is lost on redeploy.)
4. Environment variables: `DATABASE_PATH=/app/data/app.db`.
   `PORT` is provided by Render. Set `SESSION_COOKIE_SECURE=1`.
5. **Health Check Path:** `/health`.
6. Deploy and open the service URL.

### Option C — any Docker host / VPS

```sh
docker build -f Dockerfile.render -t chore-champions .
docker run -p 3000:3000 -v chore-champions-data:/app/data chore-champions
```

Or on a plain VPS with Bun installed: `bun install && bun run build &&
bun run start` (set `DATABASE_PATH` to a path that survives restarts).

## Accounts and safety

- Passwords are stored only as argon2id hashes (`Bun.password`).
  Sessions are HttpOnly cookies (`cc_session`, 30 days); only a SHA-256
  hash of the token is stored.
- Rate limits: 10 sign-ups per IP per hour, 30 sign-ins per IP per 15
  minutes, 10 failed sign-ins per email per 15 minutes.
- The Grown-Up Zone PIN is per account: only salted SHA-256 hashes of
  the PIN and recovery phrase are stored, never the values themselves.
- Every game table carries `userId` and every read/write is scoped to
  the signed-in account server-side; cross-account access returns an
  error.
