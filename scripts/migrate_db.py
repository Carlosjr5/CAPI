"""migrate_db.py
Run basic database migrations (create tables and add missing columns) directly from the app's metadata.

Usage:
  python scripts/migrate_db.py
"""
import os
import sys
import importlib

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

try:
    from app import main as app_main
except Exception as exc:
    print(f"Failed to import app.main: {exc}")
    raise


def main():
    # Create tables if they don't exist and attempt to apply lightweight column migrations
    try:
        app_main.metadata.create_all(app_main.engine)
        print("Created/verified tables using SQLAlchemy metadata")
    except Exception as exc:
        print(f"Failed to create tables: {exc}")
    try:
        if hasattr(app_main, "ensure_trade_table_columns"):
            app_main.ensure_trade_table_columns()
            print("Applied lightweight column migrations")
    except Exception as exc:
        print(f"Failed to apply column migrations: {exc}")


if __name__ == '__main__':
    main()
