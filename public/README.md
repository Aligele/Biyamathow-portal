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
   `App.jsx`, `README.md` — plus a `public` folder holding `robots.txt`,
   `sitemap.xml`, `manifest.webmanifest`, `sw.js`, `icon-192.png`,
   `icon-512.png` and `icon.svg`
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

## What the portal does

**Login portal** — polished landing page with the Ministry letterhead and three
entry points: Teacher, Administration, Student/Parent.

**Assessments** — every subject records **CAT 1**, **CAT 2** and the **Main Exam**
separately. The final subject mark is weighted (default 15% / 15% / 70%,
adjustable in Settings) and graded on the KCSE scale (A, A-, B+ … E). If a
component hasn't been entered yet, the final mark is scaled over what exists.

**Class position** — students are automatically ranked within their class and
term by average mark, with ties sharing a position. Position shows in Admin
reports, the parent view and the printed report card.

**Teacher attendance** — Admin → **Staff** marks teachers Present/Absent/Late
each day; Admin → Reports → **Teacher attendance** shows each teacher's 30-day
attendance rate.

**Reports (Admin → Reports)**
- *Fee status* — fully paid / part paid / not paid, with amounts owed
- *Results & position* — ranked table per class (Pos, Total, Avg, Grade, Pass/Fail)
- *Teacher attendance* — per-teacher present/late/absent counts and percentage

**Printable documents** — fee invoice and full report card (CATs, exam, final,
grade, remark, position, attendance, fees, grading key, signature lines).

---

## Works offline

The portal keeps working with no signal — important on patchy mobile data.

- **Opens offline.** After the first visit the app itself is cached on the phone.
- **Keeps saving offline.** Marks, attendance and new students are written to the
  phone immediately. The badge shows *"⛅ Offline — saved on this phone."*
- **Syncs automatically.** The moment signal returns, pending changes are pushed
  to the shared database and the badge returns to *"✓ All changes saved."*
- **Survives closing the app.** Unsent work is held on the device, not in memory.

**Install it as an app:** open the site in Chrome → **⋮ → Install and create
shortcut** (or *Add to Home screen*). It installs with the school seal icon and
opens full-screen with no address bar.

**One caveat worth knowing:** if two people edit offline at the same time, the
last one to reconnect wins — there is no merge. In practice this is fine when one
person handles admin, but avoid having two people enter different marks offline
simultaneously.

## Parent access & privacy

Student records are **not** publicly browsable. Each student gets a **4-digit PIN**,
auto-generated when you add them. Parents sign in with the **admission number +
PIN** and see only their own child.

- Admin → **Students** shows each PIN, with a **new PIN** button to reset it
- The PIN and admission number are printed at the bottom of the **report card**,
  so parents get their login when they receive results
- Anyone visiting the site sees only the login screen — no names, no lists

**Honest limitation:** this stops casual snooping, which is what matters day to
day. It is not bank-grade — the database key lives in the browser (that's how the
app reads data), so a technically skilled person could still query the database
directly. If that ever matters to you, the fix is tightening the Supabase row
policies to require authentication.

## Getting found on Google

The site includes an SEO title, description, School structured data,
`robots.txt`, `sitemap.xml` and a web app manifest.

**After deploying, do these two things:**

1. **Google Search Console** — https://search.google.com/search-console
   - Add your site as a **URL prefix** property using your full Vercel address
   - Verify with the **HTML tag** method: copy the `<meta name="google-site-verification" ...>`
     tag it gives you into `index.html` inside `<head>`, re-upload, redeploy, then press Verify
   - Then use **URL Inspection** → paste your homepage → **Request Indexing**

2. **Fix the two placeholder URLs.** In `public/robots.txt` and
   `public/sitemap.xml`, replace `https://biyamathow-school.vercel.app` with your
   real address.

Indexing usually takes a few days to two weeks. Because "Biyamathow" is a
distinctive name, you should rank first for it once indexed.

**A cleaner web address** helps a lot for a school. In Vercel → Settings →
Domains you can attach something like `biyamathow.sc.ke` (Kenyan school domains
are registered through a KENIC-accredited registrar).

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
