# Mashaal Rent a Car: how to put it online (free, on Netlify)

The app runs completely on **Netlify**:

- The pages are normal web pages.
- The server part is a Netlify Function.
- Your data is saved in **Netlify Blobs**, Netlify's own storage.

You don't need any other account or database. Your data stays safe when you publish a new version.

---

## Part 1: Connect the GitHub repo to Netlify

The app must be deployed **from GitHub**. Dragging and dropping the folder onto Netlify
will not work, because Netlify then skips the build step that creates the server part.

1. Go to **https://app.netlify.com** and log in (you can log in with GitHub).
2. Click **Add new project** (or **Add new site**), then **Import an existing project**.
3. Choose **GitHub** and pick the repo **ARSHMAN1776/mashaal-rent**.
4. Netlify reads the settings from the `netlify.toml` file in the repo. You don't need to change anything:
   - Build command: `npm run build`
   - Publish directory: `public`
5. Click **Deploy**. Wait 1–2 minutes until it says **Published**.

**Already made a Netlify site earlier that shows "Page not found"?**
Delete that old site (**Site configuration → Delete this site**) and do Part 1 again.
If the old site is already connected to this GitHub repo, you don't need to delete it:
it rebuilds by itself after every push.

## Part 2: Set your password (do this right away)

1. Open your Netlify address, for example `https://mashaal-rent.netlify.app`
2. The app asks you to **create a password**. Choose one and write it down somewhere safe.
3. Done. From now on, anyone who opens the address needs this password.

> Important: until you set the password, anyone who opens the address could set it.
> So set it right after the first deploy.

**Tip:** you can change the address under **Site configuration → Change site name**.

---

## Things to remember

**Download a backup once a month.**
In the app, click **Download backup** (bottom left on a computer, the ⤓ icon on a phone).
Keep the file on your computer or in Google Drive. The app also keeps its own daily copy
for the last 30 days.

**Bring back data from a backup file.**
In the app, click **Restore backup** (on a computer) and choose the backup file.
This replaces all current cars and rent entries with the ones in the file.

**Forgot your password?**
1. In Netlify, open your site and find **Blobs** in the menu.
2. Open the store named **mashaal-rent**.
3. Delete the entry named **auth**.
4. Open the app. It asks you to create a new password. Your cars and rent data are not touched.

**Updating the app later.**
Push the new code to the GitHub repo. Netlify rebuilds and publishes it by itself,
and your data stays as it is.

---

## Test on your own computer (optional)

You need Node.js (https://nodejs.org). Double-click **`Start (test on this computer).bat`**.
The app opens at `http://127.0.0.1:8765`. Data you enter there is saved in the `.data` folder
on your computer and is separate from the online version.
