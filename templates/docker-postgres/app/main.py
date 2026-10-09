"""API заметок на FastAPI. Замените на своё приложение — сохраните Dockerfile, /health и чтение DATABASE_URL."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .db import migrate, pool

log = logging.getLogger("uvicorn.error")
STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(_: FastAPI):
    if pool is None:
        log.warning("DATABASE_URL не задан — API будет отвечать 503, пока база не подключена")
        yield
        return
    pool.open(wait=True)
    applied = migrate()
    if applied:
        log.info("Применены миграции: %s", ", ".join(applied))
    yield
    pool.close()


app = FastAPI(title="%%PROJECT_NAME%%", lifespan=lifespan)


def db():
    if pool is None:
        raise HTTPException(503, "База данных ещё не подключена: нет переменной DATABASE_URL")
    return pool.connection()


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


@app.get("/health")
def health() -> dict:
    # Без обращения к базе: Render проверяет, что процесс жив и отвечает
    return {"ok": True}


@app.get("/api/notes")
def list_notes() -> list[dict]:
    with db() as conn:
        return conn.execute("select id, text, created_at from notes order by id desc limit 100").fetchall()


@app.post("/api/notes", status_code=201)
def create_note(note: NoteIn) -> dict:
    text = note.text.strip()
    if not text:
        raise HTTPException(400, "Пустая заметка")
    with db() as conn:
        return conn.execute(
            "insert into notes (text) values (%s) returning id, text, created_at", (text,)
        ).fetchone()


@app.delete("/api/notes/{note_id}", status_code=204)
def delete_note(note_id: int) -> None:
    with db() as conn:
        conn.execute("delete from notes where id = %s", (note_id,))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")
