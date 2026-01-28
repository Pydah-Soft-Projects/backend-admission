# Backend Admission — CI/CD & Deployment

This document describes the GitHub Actions CI/CD pipeline for **backend-admission** and how to configure deployment.



## Pipeline Overview

- **Workflow file:** `.github/workflows/backend-admission-cicd.yml` in the **backend repo** (GitHub requires workflows under `.github/workflows/` at repo root)
- **Scope:** Backend is a **separate repo** — workflow runs on every push/PR to `main` or `master` (no path filter)
- **Triggers:** Push and pull requests to `main` or `master`, plus manual `workflow_dispatch`

### Jobs

| Job | When | Description |
|-----|------|-------------|
| **Build & Test** | Every push/PR to `main`/`master` | `npm ci`, smoke test (start server, hit `/api/health`) |
| **Deploy** | Push to `main`/`master` only, after Build & Test passes | SSH into server, `git pull`, `npm ci --omit=dev`, `pm2 restart` |

---

## 1. CI-Only (No Deploy)

The **Build & Test** job runs without any secrets. To use only CI:

1. Push the workflow and backend changes (in the backend repo).
2. Ensure your default branch is `main` or `master` (or adjust `on.push.branches` in the workflow).

No further setup is required. The **Deploy** job will fail if you don’t configure deployment secrets; you can ignore it or remove the `deploy` job from the workflow.

---

## 2. Enabling Deployment (CD)

Deployment uses **SSH**: the workflow connects to your server and runs `git pull`, `npm ci`, and `pm2 restart`.

### 2.1 One-Time Server Setup

On the **deploy target** machine:

1. **Install Node.js 20 LTS**, npm, and **PM2**:
   ```bash
   npm install -g pm2
   ```

2. **Clone the backend repo** into your deploy directory (e.g. `/opt/backend-admission`):
   ```bash
   sudo mkdir -p /opt/backend-admission
   sudo chown "$USER" /opt/backend-admission
   git clone https://github.com/YOUR_ORG/YOUR_BACKEND_REPO.git /opt/backend-admission
   cd /opt/backend-admission
   ```
   The repo root is the app root (where `package.json` and `src/` live). Use this path as `DEPLOY_PATH`.

3. **Configure Git for deploy** (for private repos):
   - Use a **deploy key** (SSH key added to the repo) or a **GitHub token** with `repo` scope.
   - Ensure `git fetch origin` and `git pull` work from the deploy directory without interactive prompts.

4. **Create `.env`** in the backend repo root with production values (`PORT`, `DB_*`, `JWT_SECRET`, `CORS_ORIGIN`, etc.).

5. **Install deps and start with PM2** (first time):
   ```bash
   npm ci --omit=dev
   pm2 start src/server.js --name backend-api
   pm2 save
   pm2 startup   # enable restart on reboot
   ```

6. **SSH access for GitHub Actions:**
   - Create a dedicated SSH key pair for deployments.
   - Add the **public** key to the server’s `~/.ssh/authorized_keys` for the user that runs the app.
   - Store the **private** key in GitHub secrets (see below).

### 2.2 GitHub Secrets

Add these in **Settings → Secrets and variables → Actions** (repository or environment):

| Secret | Required | Description |
|--------|----------|-------------|
| `SSH_HOST` | Yes (for deploy) | Server hostname or IP |
| `SSH_USER` | Yes (for deploy) | SSH user that runs the app |
| `SSH_PRIVATE_KEY` | Yes (for deploy) | Full private key (PEM) for SSH |
| `DEPLOY_PATH` | No | Path to **backend repo root** on server (where `package.json` and `src/` live). Default: `/opt/backend-admission`. |
| `PM2_APP_NAME` | No | PM2 app name (default: `backend-api`) |
| `APP_URL` | No | Production API URL for post-deploy health check (e.g. `https://api.example.com`) |

**Note:** The workflow uses the `production` environment. Create it under **Settings → Environments** if you use environment-specific secrets. Otherwise, remove `environment: production` from the `deploy` job.

### 2.3 Deploy Flow

On push to `main`/`master`:

1. **Build & Test** runs: `npm ci`, smoke test.
2. **Deploy** runs: SSH → `cd $DEPLOY_PATH` → `git fetch` → `git reset --hard origin/main` (or `master`) → `npm ci --omit=dev` → `pm2 restart $PM2_APP_NAME` → optional health check via `APP_URL`.

---

## 3. Two-Repo Layout (Backend + Frontend)

This setup assumes **two repos**: one for backend, one for frontend. The workflow lives **only in the backend repo**:

- **Backend repo:** Contains this workflow at `.github/workflows/backend-admission-cicd.yml`. Runs on every push/PR. No path filter.
- **Frontend repo:** No backend workflow. Add a separate workflow there if you need frontend CI/CD.

---

## 4. Troubleshooting

| Issue | What to check |
|-------|----------------|
| **Deploy job fails:** “Permission denied (publickey)” | `SSH_PRIVATE_KEY` correct, public key in `authorized_keys`, `SSH_USER`/`SSH_HOST` correct |
| **Deploy fails:** “Host key verification failed” | Workflow uses `ssh-keyscan` to add the host; ensure `SSH_HOST` is reachable from GitHub runners |
| **Server:** `git fetch` / `git pull` fails | Git remote and credentials (deploy key or token) on the server |
| **Server:** `pm2 restart` fails | PM2 app name matches `PM2_APP_NAME`; run `pm2 list` on the server |
| **Health check fails** | `APP_URL` correct, server listening on expected port, `/api/health` reachable |

---

## 5. Security Notes

- Never commit `.env` or secrets. Use GitHub Actions secrets only.
- Use a dedicated deploy key or machine user for Git; restrict permissions to the repo.
- Prefer `ssh-keyscan` (as in the workflow) over disabling `StrictHostKeyChecking` for known hosts.
- Run the app under a non-root user and restrict `DEPLOY_PATH` permissions.
