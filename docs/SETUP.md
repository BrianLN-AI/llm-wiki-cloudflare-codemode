# One-Time Setup Instructions for @brian-ln

This document lists everything you need to do **once** in your Cloudflare account and GitHub repository before the CI/CD pipeline can deploy automatically.

**After completing each step, tag me in a comment on the PR and I will pick up the next piece of work.**

---

## Step 1 — Cloudflare Account ID

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com)
2. On the right sidebar of the home page, copy your **Account ID**
3. You will need this in Step 5

---

## Step 2 — Create a Cloudflare API Token

1. Go to **My Profile → API Tokens → Create Token**
2. Click **Use template** → **Edit Cloudflare Workers**
3. Set:
   - **Account** → your account
   - **Zone** → All zones (or a specific zone if you use a custom domain)
   - **Permissions**: at minimum:
     - `Account / Workers Scripts / Edit`
     - `Account / Workers KV Storage / Edit`
     - `Account / Workers R2 Storage / Edit`
     - `Account / Vectorize / Edit`
4. Click **Continue to summary** → **Create Token**
5. **Copy the token** — you will not be able to see it again

---

## Step 3 — Create the R2 Bucket

In your terminal (with [Wrangler installed](https://developers.cloudflare.com/workers/wrangler/install-and-update/)):

```bash
npx wrangler r2 bucket create llm-wiki-raw
```

Or via the dashboard: **R2 → Create bucket** → name it `llm-wiki-raw`.

---

## Step 4 — Create the Vectorize Index

```bash
npx wrangler vectorize create llm-wiki-vectors \
  --dimensions=384 \
  --metric=cosine
```

The 384 dimensions match the `@cf/baai/bge-small-en-v1.5` embedding model used for semantic search.

---

## Step 5 — Add GitHub Repository Secrets

Go to your repo: **Settings → Secrets and variables → Actions → New repository secret**

Add all three:

| Secret name | Value |
|-------------|-------|
| `CLOUDFLARE_API_TOKEN` | The token from Step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Your Account ID from Step 1 |
| `WORKER_HOST` | Your worker URL, e.g. `https://llm-wiki.YOUR_SUBDOMAIN.workers.dev` |

> **Note on `WORKER_HOST`**: You can find your workers.dev subdomain in the Cloudflare dashboard under **Workers & Pages → Overview**. It looks like `your-name.workers.dev`. The full URL will be `https://llm-wiki.your-name.workers.dev` after the first deploy.

---

## Step 6 — First Deploy

Once the secrets are set, push to `main` (or merge the open PR):

```bash
git push origin main
```

The GitHub Actions workflow (`.github/workflows/deploy.yml`) will:
1. Run TypeScript typecheck
2. Build the Vite frontend
3. Run `wrangler deploy`

---

## Step 7 — Verify

After deployment, visit your worker URL and confirm:
- The wiki UI loads
- `/api/health` returns `{ "ok": true }`
- `/mcp` returns MCP protocol JSON

---

## Optional — Local Development

```bash
npm install
cp .env.example .dev.vars
# Edit .dev.vars to set HOST=http://localhost:8787
npm run dev
```

This starts `wrangler dev` with the Vite frontend at `http://localhost:8787`.

---

## Questions?

Tag `@Copilot` in a PR comment with any questions. I'll pick up follow-on work when you do.
