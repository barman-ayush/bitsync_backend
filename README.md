# BitSync Backend

BitSync is a backend service built with Node.js, Express, TypeScript, and Prisma. It provides core infrastructure for workspace management, repository hosting, version control workflows (commits, pull requests, merge conflict resolution), and notification handling.

## Documentation

Comprehensive API specifications and architectural details are available on Notion:

* [BitSync v1 Live Documentation](https://florentine-jet-d94.notion.site/BitSync-v1-3cdde83aa7e28094baa1c120638ae7ff)

## Features

- **Authentication & User Management**: JWT and cookie-backed authentication (`/api/auth`, `/api/user`).
- **Workspaces & Repositories**: Multi-tenant workspace allocation and repository management (`/api/workspace`, `/api/repo`).
- **Version Control System**: Branching, commit tracking (`/api/commit`), pull request lifecycle management, and conflict handling (`/api/pr`).
- **Notification Engine**: Event-driven notification dispatch (`/api/notification`).

## Tech Stack

- **Runtime & Framework**: Node.js, Express.js, TypeScript
- **Database & ORM**: PostgreSQL, Prisma ORM
- **Validation & Security**: Zod, JWT, Bcrypt
- **Services**: Cloudinary, Nodemailer

## Local Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
Set up required environment variables in `.env` (Database connection, JWT secrets, Cloudinary credentials).

### 3. Generate Prisma client & build
```bash
npm run build
```

### 4. Run development server
```bash
npm run dev
```
