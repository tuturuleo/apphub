"""Пул подключений к Postgres и миграции из папки migrations."""

import os
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"

DATABASE_URL = os.environ.get("DATABASE_URL")

# Без DATABASE_URL приложение всё равно стартует (первый деплой идёт до создания базы), а API отвечает 503
pool = (
    ConnectionPool(
        DATABASE_URL,
        min_size=1,
        max_size=4,
        open=False,
        # prepare_threshold=None: без серверных prepared statements — совместимо и с пулером в transaction mode
        kwargs={"row_factory": dict_row, "autocommit": True, "prepare_threshold": None},
    )
    if DATABASE_URL
    else None
)


def migrate() -> list[str]:
    """Применяет новые .sql-файлы по порядку имён. Возвращает применённые."""
    applied: list[str] = []
    assert pool is not None
    with pool.connection() as conn:
        conn.execute(
            "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())"
        )
        with conn.transaction():
            # Несколько инстансов не должны применять миграции одновременно
            conn.execute("select pg_advisory_xact_lock(727274)")
            done = {row["name"] for row in conn.execute("select name from _migrations")}
            for path in sorted(MIGRATIONS.glob("*.sql")):
                if path.name in done:
                    continue
                conn.execute(path.read_text(encoding="utf-8"))
                conn.execute("insert into _migrations (name) values (%s)", (path.name,))
                applied.append(path.name)
    return applied
