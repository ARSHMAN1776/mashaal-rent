# Mashaal Rent a Car

A simple web app to keep track of monthly car rent.

- **Cars**: add each car with its name, number and monthly rent.
- **Monthly Rent**: each month, mark which cars have paid.
- **Dashboard**: total rent received, how many cars paid and how many didn't, and a 12-month chart.

It works on computers and phones, needs a login, and has backup and restore.

Built with **TypeScript** and **Supabase** (database and login). The website is plain
static files, so it runs on **Netlify** or **Vercel** without any server.

## Put it online

See [HOW TO PUT ONLINE.md](HOW%20TO%20PUT%20ONLINE.md).

## Run it on your computer

```
npm install
npm run dev
```

Then open http://127.0.0.1:8765

## Project layout

| Path | What it is |
| --- | --- |
| `supabase/schema.sql` | Database tables, security rules, the restore function, and the private storage bucket for payment screenshots. Run once in Supabase. |
| `src/client/config.ts` | Your Supabase project URL and anon key |
| `src/client/app.ts` | Screens and buttons |
| `src/client/db.ts` | Reading and saving data in Supabase |
| `src/client/rent.ts` | Rent calculations and input checks |
| `public/` | The page (HTML and CSS). `app.js` is built from `src/client/`. |
