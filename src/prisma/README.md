# Prisma — Database Reference

Everything you need to know about how Prisma is wired into this project, and the commands to manage the database day-to-day.

---

## 1. How Prisma is wired in this project

This project doesn't use Prisma's defaults — the schema, migrations, and generated client all live in custom locations. The wiring is:

| Thing | Location |
| --- | --- |
| Schema | `src/prisma/schema.prisma` |
| Migrations | `src/prisma/migrations/` |
| Generated client | `src/generated/prisma/` (gitignored, regenerated) |
| Prisma config | `prisma.config.ts` (project root) |
| Runtime client | `src/services/database.service.ts` (singleton, uses `@prisma/adapter-pg`) |

`prisma.config.ts` is what tells the Prisma CLI where the schema and migrations live, and it loads `DATABASE_URL` from `.env`. Because of this file, **you can run `npx prisma <cmd>` from the project root** — you do not need `--schema` flags.

### Required environment variables

In `.env` at the project root:

```
DATABASE_URL="postgresql://<user>:<password>@<host>:<port>/<dbname>"
```

That's the only one Prisma itself cares about.

---

## 2. Day-to-day workflow

### After editing `schema.prisma`

```bash
npx prisma migrate dev --name <short_snake_case_name>
```

This will:
1. Diff your schema against the DB.
2. Write a new SQL migration file into `src/prisma/migrations/<timestamp>_<name>/migration.sql`.
3. Apply it to your local DB.
4. Auto-run `prisma generate` so `src/generated/prisma/` is up to date.

**Important:** never edit an existing migration's `migration.sql`. If something is wrong, change the schema and run `migrate dev` again — Prisma will write a new migration with the diff.

### Regenerate the client only (no migration)

```bash
npx prisma generate
```

Use this if `src/generated/prisma/` is stale (e.g. after pulling someone else's migration) but you don't have any schema changes of your own.

### Open the GUI

```bash
npx prisma studio
```

Opens at `http://localhost:5555`. Useful for poking at rows without writing SQL.

---

## 3. Running a custom script against the DB

Say you have `src/scripts/script.ts` and you want to run it against the same DB the app uses. This project already exports a singleton Prisma client from `database.service.ts`, so reuse it.

### Script template

```ts
// src/scripts/script.ts
import "dotenv/config";
import db from "../services/database.service";

async function main() {
  await db.connect();

  // Use db.prisma for all queries — same client the app uses.
  const users = await db.prisma.user.findMany();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.disconnect();
  });
```

### Run it

```bash
npx ts-node src/scripts/script.ts
```

That's it. `ts-node` is already in `devDependencies`, and `import "dotenv/config"` loads `.env` so `DATABASE_URL` is set.

### Notes

- **Always `.finally(() => db.disconnect())`** — otherwise the script hangs waiting on the open pool.
- For one-off raw SQL queries, use `db.prisma.$executeRawUnsafe(...)` or `db.prisma.$queryRawUnsafe(...)`.
- For a `.sql` file (no TypeScript needed), you can also use:
  ```bash
  npx prisma db execute --file ./path/to/file.sql
  ```

---

## 4. Resetting the DB / wiping all data

### Option A — full reset (recommended)

```bash
npx prisma migrate reset
```

This:
1. Drops the entire database (or the schema, depending on the provider).
2. Re-creates it.
3. Re-applies every migration from `src/prisma/migrations/` in order.
4. Runs your seed script if one is configured.

It will prompt for confirmation. To skip the prompt (CI / scripts):

```bash
npx prisma migrate reset --force
```

Use this when you want a clean slate that exactly matches the current schema.

### Option B — wipe data but keep the schema

There's no built-in Prisma command for this. Easiest way is a script:

```ts
// src/scripts/truncate-all.ts
import "dotenv/config";
import db from "../services/database.service";

async function main() {
  await db.connect();
  // Order matters only if you don't use CASCADE.
  await db.prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "notifications",
      "repo_members",
      "repositories",
      "refresh_tokens",
      "users"
    RESTART IDENTITY CASCADE;
  `);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.disconnect());
```

Run with `npx ts-node src/scripts/truncate-all.ts`.

### Option C — nuke and re-sync schema without migrations (prototype only)

```bash
npx prisma db push --force-reset
```

This drops everything and pushes the current `schema.prisma` directly to the DB **without creating a migration**. Use only on a throwaway local DB while prototyping — never on a DB whose state needs to match committed migrations.

---

## 5. Production / shared envs

```bash
npx prisma migrate deploy
```

Applies any pending migrations without creating new ones, without prompting, and without running `generate`. This is the only `migrate` command you should run against a shared DB. Never run `migrate dev` or `migrate reset` outside your local machine.

---

## 6. Troubleshooting

| Problem | Fix |
| --- | --- |
| `Environment variable not found: DATABASE_URL` | `.env` missing at project root, or you're running from a different cwd. |
| Generated types out of date after pulling | `npx prisma generate` |
| "Drift detected" on `migrate dev` | DB has changes that don't match migrations. Either reset (local only) or write a new migration to bring things back in sync — do **not** edit old migrations. |
| Client imports break (`Cannot find module '../generated/prisma/client'`) | Run `npx prisma generate`. The folder is gitignored, so a fresh clone needs this. |
| Script hangs after finishing | You forgot `db.disconnect()` in `.finally`. |

---

## 7. Files you should never edit by hand

- Anything under `src/prisma/migrations/` after it has been committed.
- `src/prisma/migrations/migration_lock.toml`.
- Anything under `src/generated/prisma/` — it is regenerated on every `prisma generate`.
