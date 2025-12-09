import csv
import os
import sqlite3
from urllib.parse import urlparse

import psycopg2
from dotenv import load_dotenv

load_dotenv()

# Change this to your table name
TABLE_NAME = "trades"
OUTPUT_CSV = f"{TABLE_NAME}.csv"
PREVIEW_CSV = f"{TABLE_NAME}_preview.csv"

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


def sanitize_row(row, col_names):
    """
    Normalize null-ish fields per column:
    - For exit_price, use a blank when missing to keep the column numeric-friendly for previews.
    - For everything else, use empty string to keep previews tidy while preserving column count.
    """
    cleaned = []
    for col, value in zip(col_names, row):
        if value is None:
            cleaned.append("")
        else:
            cleaned.append(value)
    return cleaned


def write_preview(rows, col_names):
    """Write a lightweight preview CSV without the verbose response/reservation/pine fields."""
    keep_cols = [
        "id",
        "signal",
        "symbol",
        "price",
        "size",
        "size_usd",
        "leverage",
        "margin",
        "liquidation_price",
        "exit_price",
        "realized_pnl",
        "status",
        "created_at",
    ]
    # Map column name to index for fast lookup
    idx = {name: i for i, name in enumerate(col_names)}

    with open(PREVIEW_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(keep_cols)
        for row in rows:
            sanitized = sanitize_row(row, col_names)
            writer.writerow([sanitized[idx[c]] if c in idx else "" for c in keep_cols])


def main():
    conn, driver = connect_db()
    cur = conn.cursor()

    cur.execute(f"SELECT * FROM {TABLE_NAME};")

    rows = cur.fetchall()
    col_names = [desc[0] for desc in cur.description]

    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(col_names)  # header
        for row in rows:
            writer.writerow(sanitize_row(row, col_names))

    # Write preview file without the verbose JSON column
    write_preview(rows, col_names)

    print(f"✓ Exported to {OUTPUT_CSV} and {PREVIEW_CSV} using {driver}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
