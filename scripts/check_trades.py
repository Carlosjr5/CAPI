import os
import csv
import sqlite3
from urllib.parse import urlparse

import psycopg2
from dotenv import load_dotenv

load_dotenv()

# Change this to your table name
TABLE_NAME = "trades"
OUTPUT_CSV = f"{TABLE_NAME}.csv"

database_url = os.getenv("DATABASE_URL")

def connect_db():
    """Connect to Postgres when DATABASE_URL is set, otherwise fallback to local SQLite trades.db."""
    if database_url:
        parsed = urlparse(database_url)
        if parsed.scheme.startswith("postgres"):
            return psycopg2.connect(database_url), "postgres"
        if parsed.scheme.startswith("sqlite"):
            # sqlite:///path or sqlite:///:memory:
            path = database_url.replace("sqlite:///", "", 1)
            return sqlite3.connect(path), "sqlite"
    # default: local sqlite file
    default_path = os.path.join(os.path.dirname(__file__), "..", "trades.db")
    return sqlite3.connect(default_path), "sqlite"


conn, driver = connect_db()
cur = conn.cursor()

# Run query
cur.execute(f"SELECT * FROM {TABLE_NAME};")

# Fetch data + column names
rows = cur.fetchall()
if driver == "sqlite":
    col_names = [desc[0] for desc in cur.description]
else:
    col_names = [desc[0] for desc in cur.description]

# Write to CSV
with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(col_names)  # header
    writer.writerows(rows)

print(f"✓ Exported to {OUTPUT_CSV} using {driver}")

# Cleanup
cur.close()
conn.close()
