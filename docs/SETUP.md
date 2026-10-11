# Developer Setup (personal use, $0)

Do these once, before we write any code. Each step says what it is for.

> **Never paste secrets** (database password, Google client secret, encryption keys) into chat, code or git. They go only in a local `.env` file, which will be git-ignored.

---

## 0. Tools on your machine

| Tool | Status (checked 2026-10-11) | Action |
|---|---|---|
| Node.js | v22.14.0 ✔ | Nothing. Node 22 is a supported LTS release. |
| npm | 11.12.1 ✔ | Nothing |
| Git | 2.48.1 ✔ | Nothing |
| Docker | 28.5.1 ✔ | Not needed while we use Supabase. It's useful later for running tests against a throwaway database. |
| **pnpm** | ✘ missing | Run `npm install -g pnpm`, then check with `pnpm -v` |
| gcloud CLI | ✘ missing | Not needed until we deploy to Cloud Run |

Also create a **GitHub account** if you don't have one. We'll push the code to a **private** repository.

---

## 1. Supabase (our PostgreSQL database)

We use Supabase **only as a PostgreSQL database**. We do **not** use Supabase Auth, Storage, or its auto-generated REST API. Our own backend does those jobs.

1. Sign up at https://supabase.com. GitHub login is easiest.
2. **New project:**
   - **Name:** `job-tracker-dev`
   - **Database password:** click *Generate*, then save it in a password manager.
     - Tip: a password with only letters and digits avoids URL-encoding problems in the connection string.
   - **Region:** **South Asia (Mumbai)**, the closest to you.
   - **Plan:** Free.
   - If the form offers *Enable Data API* or *automatically expose new tables*, **turn them off**. We don't use them (see the security note below).
3. Wait about 2 minutes for the project to start.
4. Get the connection string: click **Connect** at the top of the project page and choose **Session pooler**. It looks like this:
   ```
   postgresql://postgres.<project-ref>:<YOUR-PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
   - Use **Session pooler (port 5432)**, *not* "Direct connection". The direct connection needs IPv6, which many home networks in India don't have.
   - Don't use "Transaction pooler" (port 6543) either. Our job queue and sync locks need a normal session.
5. Keep that string for the `.env` file (step 4).

**Security note: why turn off the Data API.** Supabase can automatically publish tables in the `public` schema as a web API. We'll also keep all our tables in a private schema called `app`, so nothing is exposed even if that setting is on.

**Free-tier behaviour to know** (check current limits on Supabase's pricing page):
- Free projects **pause after about a week with no activity**. If that happens, open the dashboard and click **Restore**. Once the app is hosted and syncing every 10–15 minutes, it stays active.
- Database size limit is about 500 MB. That's plenty: we never store full emails.
- Backups on the free tier are limited. We'll add our own weekly backup later.

---

## 2. Google Cloud project: "Sign in with Google" and Gmail access

This is the most important setup step. It lets the app sign you in and, separately, read your Gmail.

1. Go to https://console.cloud.google.com and sign in with the Google account you want to *own* the app.
2. **Create a project:** project picker (top bar) → **New project** → name it `job-tracker`.
3. **Enable the Gmail API:** *APIs & Services → Library* → search **Gmail API** → **Enable**.
4. **Set up the consent screen:** open **Google Auth Platform** (search for it in the top bar) → **Get started**.
   - **App name:** `Job Tracker (dev)`. **Support email:** your email.
   - **Audience:** **External**.
   - **Contact email:** your email → agree → **Create**.
5. **Audience → Test users:** **add every Gmail address you'll connect**: your personal Gmail, your college Gmail, and so on.
   - The app stays in **Testing** mode. Don't click "Publish". That keeps it private, and Google's review isn't needed.
   - In Testing mode, Gmail access **expires every 7 days**. The app will show a "Reconnect" button when it does. This is expected.
6. **Data Access → Add or remove scopes.** Add these four:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `.../auth/gmail.readonly` (listed as a *restricted* scope; fine in Testing mode)
   - Then click **Save**.
7. **Clients → Create client:**
   - **Application type:** Web application. **Name:** `job-tracker-local`.
   - **Authorized JavaScript origins:** `http://localhost:3000`
   - **Authorized redirect URIs** (add both):
     - `http://localhost:3000/api/auth/google/callback` (for sign-in)
     - `http://localhost:3000/api/auth/google/mailbox/callback` (for connecting Gmail)
   - Click **Create**.
8. **Copy the Client ID and Client secret right away.** Google may only show the secret once. Store both in your password manager.

Expect Google to show **"Google hasn't verified this app"** when you connect Gmail. Click *Continue*. This is normal for Testing mode.

---

## 3. Generate the app's own secret keys

Run this in a terminal **twice**. It prints a different random key each time.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Key | Purpose |
|---|---|
| First output → `TOKEN_ENCRYPTION_KEY` | Encrypts your Gmail access token in the database |
| Second output → `HMAC_PEPPER` | Makes stored email fingerprints unguessable |

> If you lose `TOKEN_ENCRYPTION_KEY`, nothing leaks. You just reconnect Gmail. Don't change it casually.

---

## 4. The `.env` file (created in task 1)

During project setup I'll create `.env.example` (no secrets, safe to commit) and add `.env` to `.gitignore`. You then copy it to `.env` and fill in:

```dotenv
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
GOOGLE_CLIENT_ID=<from step 2.8>
GOOGLE_CLIENT_SECRET=<from step 2.8>
TOKEN_ENCRYPTION_KEY=<from step 3>
HMAC_PEPPER=<from step 3>
```

---

## Checklist

- [ ] `pnpm -v` prints a version
- [ ] GitHub account ready
- [ ] Supabase project `job-tracker-dev` (Mumbai) created; session-pooler connection string saved
- [ ] Google Cloud project created, Gmail API enabled
- [ ] Consent screen in **Testing** mode with your Gmail address(es) as test users
- [ ] Four scopes added
- [ ] Web OAuth client created with both redirect URIs; ID and secret saved
- [ ] Two random keys generated and saved

When all of these are ticked, we start task 1 (project setup).
