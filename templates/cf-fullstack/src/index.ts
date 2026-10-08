// API приложения. Статика из ./public отдаётся Cloudflare сама, сюда попадают только запросы /api/*.

export interface Env {
  DB: D1Database;
}

interface Note {
  id: number;
  text: string;
  created_at: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/notes" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM notes ORDER BY id DESC LIMIT 100").all<Note>();
      return json(results);
    }

    if (url.pathname === "/api/notes" && request.method === "POST") {
      const { text } = await request.json<{ text?: string }>();
      if (!text?.trim()) return json({ error: "Пустая заметка" }, 400);
      const note = await env.DB.prepare("INSERT INTO notes (text) VALUES (?) RETURNING *")
        .bind(text.trim().slice(0, 1000))
        .first<Note>();
      return json(note, 201);
    }

    const match = url.pathname.match(/^\/api\/notes\/(\d+)$/);
    if (match && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(Number(match[1])).run();
      return new Response(null, { status: 204 });
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
