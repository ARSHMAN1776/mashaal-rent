# Mashaal Rent a Car

A simple web app to keep track of monthly car rent.

- **Cars**: add each car with its name, number and monthly rent.
- **Monthly Rent**: each month, mark which cars have paid.
- **Dashboard**: total rent received, how many cars paid and how many didn't, and a 12-month chart.

It works on computers and phones, needs a password to open, and has backup and restore.

Built with **TypeScript**. It runs on **Netlify**: a Netlify Function for the server part
and **Netlify Blobs** for the data.

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
| `public/` | The page (HTML and CSS). `app.js` is built from `src/client/app.ts`. |
| `src/client/app.ts` | Page code |
| `src/server/core.ts` | All server logic: login, cars, rent, backup |
| `src/server/blob-store.ts` | Saves data in Netlify Blobs |
| `src/server/file-store.ts` | Saves data in `.data/` when testing on your computer |
| `netlify/functions/api.ts` | The Netlify Function that answers `/api/*` |
| `scripts/dev.ts` | Local test server |
