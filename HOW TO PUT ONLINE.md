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

   Paste them into `src/client/config.ts`, or send them to Claude to do it.
   **Never** use the `service_role` or `secret` key.

## Part 2: Put the website online

Use **one** of these. Both read their settings from the project files, so don't change any settings.

**Netlify:** **Add new project** → **Import an existing project** → **GitHub** →
pick **ARSHMAN1776/mashaal-rent** → **Deploy**.

**Vercel:** **Add New…** → **Project** → import **ARSHMAN1776/mashaal-rent** → **Deploy**.

If you already made a site for this repo, it rebuilds by itself after each push.
You don't need to make a new one.

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

**Forgot your password?**
In Supabase, open **Authentication** → **Users**, delete your user, and add it again with a new password
(Part 1, step 3). Your cars and rent data are not affected.

**See or fix data directly.**
In Supabase, open **Table Editor**. The data is in the `cars` and `payments` tables.

---

## Test on your own computer (optional)

You need Node.js (https://nodejs.org). Double-click **`Start (test on this computer).bat`**.
The app opens at `http://127.0.0.1:8765` and uses the same Supabase data as the online version.
