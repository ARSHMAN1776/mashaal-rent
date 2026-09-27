# Mashaal Rent a Car: how to put it online (free)

How it works:

- **Supabase** keeps your data (cars and rent) and handles the login.
- **Netlify or Vercel** shows the website. It is plain web pages, so either one works.

Both have free plans.

---

## Part 1: Set up Supabase (about 10 minutes)

1. Go to **https://supabase.com**, sign in, and click **New project**.
   - Give it a name, for example `mashaal-rent`.
   - Choose a **database password** and keep it safe. The app does not use it, but Supabase asks for it.
   - Region: pick the one closest to you, for example **Mumbai** or **Singapore**.
   - Wait 1–2 minutes until the project is ready.

2. **Create the tables.**
   Open **SQL Editor** → **New query**. Open the file `supabase/schema.sql` from this project
   in Notepad, copy everything, paste it, and click **Run**. It should say **Success**.
   This also sets up a private place to store payment screenshots.
   (If you already ran an older copy of this file, run the new one again — it's safe, and it
   won't touch any data you already have. It only adds the screenshot feature.)

3. **Create your login.**
   Open **Authentication** → **Users** → **Add user** → **Create new user**.
   Type your email and a password, tick **Auto Confirm User**, and click **Create user**.
   This email and password are what you use to log in to the app.
   Add more users the same way if other people need access.

4. **Stop strangers from signing up.**
   Open **Authentication** → **Sign In / Providers** (on some projects it is under **Settings**)
   and turn **off** "Allow new users to sign up". Click **Save**.

5. **Copy two values.**
   Open **Project Settings** → **API** (or click **Connect** at the top). Copy:
   - **Project URL** (looks like `https://abcdxyz.supabase.co`)
   - **anon public** key (or **publishable** key)

   You'll paste these into Netlify or Vercel as environment variables in Part 2 — send
   them to Claude and it can set them for you there. **Never** use the `service_role` or `secret` key.

## Part 2: Put the website online

Use **one** of these. Both read their build settings from the project files, so you
only need to add the two Supabase values as environment variables — nothing else to change.

**Netlify:** **Add new project** → **Import an existing project** → **GitHub** →
pick **ARSHMAN1776/mashaal-rent**. Before clicking Deploy, open **Add environment variables**
and add both:
| Key | Value |
| --- | --- |
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |

Then click **Deploy**. (Already deployed without these? Go to **Site configuration** →
**Environment variables** → **Add a variable**, add both, then **Deploys** → **Trigger deploy**.)

**Vercel:** **Add New…** → **Project** → import **ARSHMAN1776/mashaal-rent**. Open
**Environment Variables** and add the same two (`SUPABASE_URL`, `SUPABASE_ANON_KEY`), then **Deploy**.
(Already deployed? **Settings** → **Environment Variables** → add both → **Deployments** →
**Redeploy** on the latest one.)

If you already made a site for this repo, it rebuilds by itself after each push,
but you still need to add the two environment variables once — a build without them fails
with a message saying which one is missing.

When it's published, open the address and log in with the email and password from Part 1, step 3.

---

## Things to remember

**Use it at least once a week, or Supabase pauses it.**
On the free plan, Supabase pauses a project after 7 days with no use.
If that happens, open the project in Supabase and click **Restore project**. Your data is kept.

**Download a backup once a month.**
In the app, click **Download backup** (bottom left on a computer, the ⤓ icon on a phone).
Keep the file on your computer or in Google Drive.

**Bring back data from a backup.**
In the app, click **Restore backup** (on a computer) and choose the file.
This replaces all current cars and rent entries with the ones in the file.
Note: backup files do not include payment screenshots, so restoring one removes them.

**Payment screenshots.**
When marking rent as paid, you can attach a photo of the payment (or a PDF).
They're kept in a private Supabase Storage bucket named `receipts` — only logged-in
users can see them. The free plan gives 1 GB of storage, which is several thousand
photos, so this normally doesn't run out.

**Forgot your password?**
In Supabase, open **Authentication** → **Users**, delete your user, and add it again with a new password
(Part 1, step 3). Your cars and rent data are not affected.

**See or fix data directly.**
In Supabase, open **Table Editor**. The data is in the `cars` and `payments` tables
(screenshots are listed in `receipts`, and the files themselves are under **Storage**).

---

## Test on your own computer (optional)

You need Node.js (https://nodejs.org). The first time, copy `.env.example` to a new file
named `.env` and paste in the same two Supabase values from Part 1, step 5.
Then double-click **`Start (test on this computer).bat`**.
The app opens at `http://127.0.0.1:8765` and uses the same Supabase data as the online version.
