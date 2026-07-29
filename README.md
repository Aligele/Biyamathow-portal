# Biyamathow Senior School — Portal

Attendance, exam results and fees portal for **Biyamathow Mixed Day and Boarding
Senior School**, Sabuli, Wajir County.

Roles: **Admin** (classes, teachers, students, fees, reports, backup),
**Teacher** (attendance + results for their assigned subjects),
**Student/Parent** (attendance, published results, printable invoice & report card).

---

## 1. Put the files on GitHub (from your phone)

All 7 files sit at the **top level** — there are no folders to recreate.

1. Extract the zip using your phone's **Files / My Files** app (tap the zip →
   Extract). You should see these 7 files:
   `package.json`, `vite.config.js`, `index.html`, `main.jsx`, `store.js`,
   `App.jsx`, `README.md`
2. On GitHub, tap **+ → New repository**. Name it `biyamathow-portal`,
   keep it **Private** if you prefer, then **Create repository**.
3. On the new empty repo page, tap **uploading an existing file**
   (or **Add file → Upload files**).
4. Tap **choose your files**, then select **all 7 files** at once from where you
   extracted them.
5. Scroll down and tap **Commit changes**.

That's it — no folders, no editing needed.

## 1b. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) and sign in (use **Continue with
   GitHub** so it can see your repo).
2. Tap **Add New… → Project**.
3. Find `biyamathow-portal` and tap **Import**.
4. Vercel detects Vite automatically — don't change any settings. Tap **Deploy**.
5. Wait ~1 minute. You'll get a live link like
   `https://biyamathow-portal.vercel.app`.

The app works at this point, but each phone still keeps its own data.
Step 2 makes it shared — **do it before giving the link to teachers.**

---

## 2. Turn on the shared database — ALREADY SET UP FOR YOU ✅

Your Supabase project is created and the table is live. You only need to add two
environment variables in Vercel.

In Vercel → your project → **Settings → Environment Variables**, add these two
(select all environments: Production, Preview, Development):

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://enpwvgtgavtfnbhapdcf.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_qzFzLY-ZddliZZtEfRiUiA_lAdUcrq7` |

Then **Redeploy** (Vercel → Deployments → ⋯ → Redeploy). Environment variables
are read when the site is built, so a redeploy is required for them to take effect.

**Confirm it worked:** open the site → **Admin → Backup**. It should say
*"Shared database is active — every teacher, parent and admin sees the same data."*

<details>
<summary>Already done for you (no action needed)</summary>

Supabase project `biyamathow-school` (region: eu-central-1) with this table:

```sql
create table app_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table app_state enable row level security;
create policy "portal read"   on app_state for select using (true);
create policy "portal insert" on app_state for insert with check (true);
create policy "portal update" on app_state for update using (true);
```
Read and write were both tested successfully.
</details>

---

## 3. First-time setup in the app

1. Open the site, tap **Admin**, passcode `admin123`.
2. **Settings** → change the admin passcode immediately.
3. **Classes** → add your classes.
4. **Teachers** → add each teacher (their login is shown when created), then tap
   the subject chips to set which subjects they teach.
5. **Students** → add students with their term fee.
6. Share the site link with teachers and parents.

### Make it feel like an app
On the site, use the browser menu → **Install and create shortcut** /
**Add to Home screen**. It then opens full-screen from the home screen icon.

---

## Security notes — please read

- The site link is **public**. The admin passcode is the only barrier to the
  admin panel, so change it from the default and don't post the link publicly.
- The SQL policies above let **anyone with the site link** read and write the
  data. That's normal for a small internal tool but is not strong security. If
  you later need proper protection, add Supabase Auth and restrict the policies
  to signed-in users.
- Teacher passwords are stored as plain text in the database. Fine for an
  internal staff tool; don't reuse important personal passwords.

## Backups
**Admin → Backup** shows all data as text you can copy into Notes/WhatsApp/email,
and a box to paste it back to restore. Do this at the end of each term.
