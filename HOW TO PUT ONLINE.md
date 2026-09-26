# Mashaal Rent a Car: how to put it online (free)

The app runs on **PythonAnywhere**, which has a free plan. You get a web address like
`https://yourname.pythonanywhere.com` that you can open from any computer or phone.

The free plan does not need a credit card. Your data is kept on PythonAnywhere's disk,
so it stays safe when their server restarts.

---

## Part 1: Create your free account (5 minutes)

1. Go to **https://www.pythonanywhere.com** and click **Pricing & signup**.
2. Choose **Create a Beginner account** (the free one).
3. Pick your **username** carefully. It becomes your web address.
   Example: username `mashaalrent` gives `https://mashaalrent.pythonanywhere.com`
4. Confirm your email.

## Part 2: Upload the app

1. In this folder, find **`mashaal-rent-upload.zip`**.
2. On PythonAnywhere, open the **Files** tab.
3. Click **Upload a file** and choose `mashaal-rent-upload.zip`.
4. Open the **Consoles** tab and click **Bash**. A black window opens.
5. Type this line and press Enter:

   ```
   unzip -o mashaal-rent-upload.zip -d mashaal-rent
   ```

6. Close the console.

## Part 3: Turn on the website

1. Open the **Web** tab and click **Add a new web app**, then **Next**.
2. Choose **Manual configuration** (not Flask or Django).
3. Choose the **newest Python version** in the list (3.11 or newer), then click **Next**.
4. On the Web tab, find **WSGI configuration file** and click the link next to it.
   A file editor opens.
5. **Delete everything** in that file.
6. Open `pythonanywhere_wsgi.py` from this folder in Notepad, copy all of it, and
   paste it into the editor.
7. In the pasted text, change `YOUR_USERNAME` to your PythonAnywhere username.
8. Click **Save**.
9. Go back to the **Web** tab. Scroll down to **Security** and turn on **Force HTTPS**.
10. Scroll to the top and click the green **Reload** button.

## Part 4: Set your password (do this right away)

1. Open your web address, for example `https://mashaalrent.pythonanywhere.com`
2. The app asks you to **create a password**. Choose one and write it down somewhere safe.
3. Done. From now on, anyone who opens the address needs this password.

> Important: until you set the password, anyone who opens the address could set it.
> So set it right after Part 3.

---

## Things to remember

**Every 3 months, click one button.**
On the free plan the website turns off after 3 months unless you extend it.
PythonAnywhere emails you a reminder. Log in, open the **Web** tab and click
**"Run until 3 months from today"**. Your data is never deleted.

**Download a backup once a month.**
In the app, click **Download backup** (bottom left). Save the file on your computer
or in Google Drive. The server also keeps its own daily copy for the last 30 days
in the `mashaal-rent/backups` folder.

**Forgot your password?**
On PythonAnywhere, open the **Consoles** tab, start **Bash**, and run:

```
cd mashaal-rent && python3 -c "import sqlite3; c=sqlite3.connect('data/rent.db'); c.execute(\"DELETE FROM settings WHERE key='password'\"); c.commit()"
```

Then open the app. It asks you to create a new password. Your cars and rent data are not touched.

**Bring back data from a backup file**
1. On the **Files** tab, open `mashaal-rent/data/`.
2. Upload your backup file, then rename it to `rent.db`, replacing the old one.
3. On the **Web** tab, click **Reload**.

**Updating the app later**
Upload the new zip and run the same `unzip` line again. It replaces the app files
but never touches the `data` folder, where your data lives. Then click **Reload** on the Web tab.

---

## Test on your own computer (optional)

Double-click **`Start (test on this computer).bat`**. The app opens in your browser
at `http://127.0.0.1:8765`. The data you enter there stays on your computer and is
separate from the online version.
