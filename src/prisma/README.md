# Prisma - Database Schema Management

## After any schema change (`schema.prisma`) - Local DB 

1. **Create and apply migration:**
   ```bash
   npx prisma migrate dev --name <migration_name>
   ```
   This creates a `.sql` migration file and auto-runs `prisma generate`.

2. **Generate the DB schema changes to the local DB**:
   ```bash
   npx prisma generate
   ```

## Other useful commands

- **View DB in browser:** `npx prisma studio`
- **Reset DB (destructive):** `npx prisma migrate reset`
- **Apply migrations in production:** `npx prisma migrate deploy`
