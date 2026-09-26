# Mashaal Rent a Car

A simple web app to keep track of monthly car rent.

- **Cars**: add each car with its name, number and monthly rent.
- **Monthly Rent**: each month, mark which cars have paid.
- **Dashboard**: total rent received, how many cars paid and how many didn't, and a 12-month chart.

It works on computers and phones, needs a password to open, and saves all data in one
SQLite file (`data/rent.db`). It uses only the Python standard library, so there is
nothing to install.

## Run it on your computer

```
python app.py
```

Then open http://127.0.0.1:8765

## Put it online for free

See [HOW TO PUT ONLINE.md](HOW%20TO%20PUT%20ONLINE.md). It uses PythonAnywhere's free plan.
