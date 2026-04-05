# Prisma - Database Schema Management

## After any schema change (`schema.prisma`)

1. **Create and apply migration:**
   ```bash
   npx prisma migrate dev --name <migration_name>
   ```
   This creates a `.sql` migration file and auto-runs `prisma generate`.

2. **If you only need to regenerate the client** (no DB changes):
   ```bash
   npx prisma generate
   ```

## Other useful commands

- **View DB in browser:** `npx prisma studio`
- **Reset DB (destructive):** `npx prisma migrate reset`
- **Apply migrations in production:** `npx prisma migrate deploy`
