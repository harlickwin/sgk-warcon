# SGK deploy: Warcon on Railway

This fork of [warcon-app/warcon](https://github.com/warcon-app/warcon) runs the SGK WARDOGS server's
admin panel. Upstream's README is the reference for Warcon itself; this file only covers our Railway
setup.

- **Railway project:** `sgk-wardogs` (workspace: harlickwin's Projects), environment `production`
- **Region:** Southeast Asia (Singapore), `asia-southeast1-eqsg3a`, for both services
- **Panel:** https://sgk-wardogs.up.railway.app

## Services

| Service  | Source                                    | Notes                                                                                                |
| -------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `db`     | image `timescale/timescaledb:2.30.0-pg18` | Volume `db-volume` mounted at `/var/lib/postgresql`. Keep the tag in step with `docker-compose.yml`. |
| `warcon` | this repo, branch `main`, `Dockerfile`    | `WARCON_ROLE=all`: web panel and worker in one process. Public domain on port 3000.                  |

`railway.json` holds the `warcon` build and deploy settings: Dockerfile build, health check on
`/api/health`, restart always, **never sleep**, and one replica in Singapore. The `db` settings
(Singapore, restart always, no sleep) were set through the Railway API because an image service has
no repo to hold a config file.

## Environment variables

Every secret is set in Railway only. Never commit one.

`db`:

| Variable            | Value                           |
| ------------------- | ------------------------------- |
| `POSTGRES_USER`     | `warcon`                        |
| `POSTGRES_PASSWORD` | random hex (generated at setup) |
| `POSTGRES_DB`       | `warcon`                        |

`warcon`:

| Variable                               | Value                                | Why                                                                                                                                   |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PGHOST`                               | `${{db.RAILWAY_PRIVATE_DOMAIN}}`     | Private network (`db.railway.internal`)                                                                                               |
| `PGPORT`                               | `5432`                               |                                                                                                                                       |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `${{db.POSTGRES_USER}}` etc.         | References, so a password rotation on `db` flows through                                                                              |
| `ORIGIN`                               | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Must be the exact URL people open, and is the kill-feed `Url`                                                                         |
| `WARCON_ROLE`                          | `all`                                | Serve, run the worker in-process and migrate on start                                                                                 |
| `PORT`                                 | `3000`                               |                                                                                                                                       |
| `RELAY_URL` / `WORKER_PORT`            | `http://localhost:7700` / `7700`     | Only used by the split roles; harmless under `all`                                                                                    |
| `ADDRESS_HEADER`                       | `x-real-ip`                          | The real client IP behind Railway's proxy, for rate limits                                                                            |
| `WARCON_COMMIT`                        | `${{RAILWAY_GIT_COMMIT_SHA}}`        | The commit shown on the Admin overview                                                                                                |
| `BETTER_AUTH_SECRET`                   | `openssl rand -base64 32`            | Signs sessions                                                                                                                        |
| `ENCRYPTION_KEY`                       | `openssl rand -base64 32`            | **Encrypts stored RCON passwords and the feed token. Back it up.** If it is lost, every server's RCON password must be entered again. |
| `RELAY_SECRET`                         | random hex                           | Only used by the split roles                                                                                                          |
| `SETUP_TOKEN`                          | random hex                           | Needed once, for first-run owner setup, so nobody else can claim the panel                                                            |

To read a value: `railway variables --service warcon --kv`, or in the dashboard under the service's
Variables tab.

## Migrations

Under `WARCON_ROLE=all` Warcon **migrates on every start**, so no separate step is needed.
Deploying a new commit applies any new files under `drizzle/`. To run migrations by hand, for
example against a DB restored from backup:

```sh
railway ssh --service warcon -- bun ./build/migrate.js
```

If we ever split into `web` + `worker` services (upstream's compose layout), those roles **refuse to
start** with pending migrations. Then set `WARCON_ROLE=migrate` on a one-off service, or add
`bun ./build/migrate.js` as the web service's pre-deploy command.

## Updating from upstream

```sh
git fetch upstream
git checkout -b sync-upstream origin/main
git rebase upstream/main          # our changes are kept isolated, so conflicts should be rare
bun install && bun test           # needs TEST_DATABASE_URL for the DB suites (see upstream README)
git push -u origin sync-upstream  # open a PR, merge, and Railway redeploys main
```

Before merging, check that `docker-compose.yml` hasn't moved to a new TimescaleDB tag. If it has,
update the `db` image on Railway (Settings → Source) **before** deploying Warcon. A major Postgres
version bump needs a dump and restore, not just a tag change.

## Backups

The volume survives redeploys and restarts. It is not a backup. Take a dump from time to time:

```sh
railway ssh --service db -- pg_dump -U warcon -Fc warcon > warcon-$(date +%F).dump
```

Railway also offers scheduled volume backups (db service → Backups).

## Kill feed

On the server's **Config** tab, click **Configure** under the kill feed. Warcon mints a token and,
when the game's config document is writable over RCON, writes this itself:

```ini
[WDServerFeed]
Url=https://sgk-wardogs.up.railway.app
Token=wkf_...
```

`Url` is the origin only, because the game appends `/api/ingest/events`. The game reads the section
**at restart**. If Warcon can't write it, add it by hand in xREALM File Access and restart. After
each xREALM restart, check that the section is still there: some hosts regenerate
`ServerSettings.ini`.

## Cost (rough)

Railway Hobby is US$5/month, and that includes US$5 of usage. At idle the pair uses about
0.4–0.6 GB of RAM and a small slice of CPU, plus a volume of under 1 GB. **Expect about US$7–12 a
month in total**, rising with player count and kill history. Check it any time with `railway usage`.

## Anti-cheat (Phase 2: headshot rules, watch only)

Our addition to upstream: the **Headshot anti-cheat** automation rule. The code lives in
`src/lib/headshot.ts`, `src/lib/server/headshot*.ts` and the Anti-cheat tab. It adds one table,
`hs_trips` (migration `0035`).

| Rule     | Default trigger                                                                          |
| -------- | ---------------------------------------------------------------------------------------- |
| HS_BURST | ≥ 5 headshot kills by one player within 10 s                                             |
| HS_RATIO | ≥ 90% headshots over ≥ 15 kills in a rolling 5 min (never < 8)                           |
| HS_RANGE | a headshot beyond the limit: Glock 17 80 m, M500 60 m, SMG 120 m (no SMG seen yet)       |
| REPEAT   | any rule tripping again within 24 h is marked repeat and alerts even inside the cooldown |

- Only gun kills of the other side count. Team kills, suicides, environment deaths, vehicles and
  their guns, buildables, explosives (grenade, C4, RPG) and melee are all left out.
- Each check is `off` or `watch`. `enforce` is refused until the watch data has been reviewed
  (Phase 4).
- Every trip goes into `hs_trips`. At most one alert goes out per player per rule every 10 minutes
  by default; trips inside that window are still logged.
- The per-player windows are rebuilt from `kills` and `hs_trips` after a restart.

**Setup**

1. Server → **Automation** → Add → **Headshot anti-cheat**. Keep the defaults, then click **Dry
   run** to see the last 24 h.
2. Org page → **Discord webhooks** → add the `#anticheat-alerts` channel's webhook and tick only
   **Anti-cheat alerts**. These alerts don't go to channels carrying "Automation", so
   general channels never see the evidence.
3. Server → **Anti-cheat** tab: trips with counts per rule; click a row for the kills. **Replay**
   runs the saved settings over up to 90 days of stored kills.

Adding a weapon to HS_RANGE: find its cause on the Kills tab (the filter lists them), for example
`Id.Item.MP5`, and add it to a class in the rule's settings.
