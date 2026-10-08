import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const status = document.getElementById("status");
const list = document.getElementById("notes");
const form = document.getElementById("form");
const input = document.getElementById("text");

function fail(error) {
  status.textContent = `Ошибка: ${error.message}`;
  status.classList.add("error");
}

// Анонимный вход: у каждого браузера свой пользователь, правила RLS показывают ему только его заметки.
// Чтобы перейти на email или OAuth, замените signInAnonymously на signInWithOtp / signInWithOAuth.
async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return true;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) {
    fail(error);
    return false;
  }
  return true;
}

async function load() {
  const { data, error } = await supabase.from("notes").select("id, text").order("id", { ascending: false });
  if (error) return fail(error);
  list.replaceChildren(
    ...data.map((note) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = note.text;
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Удалить";
      del.onclick = async () => {
        const { error } = await supabase.from("notes").delete().eq("id", note.id);
        if (error) return fail(error);
        load();
      };
      li.append(text, del);
      return li;
    }),
  );
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await supabase.from("notes").insert({ text: input.value.trim() });
  if (error) return fail(error);
  input.value = "";
  load();
});

if (await ensureSession()) {
  status.textContent = "Вы вошли анонимно: заметки хранятся в Postgres и видны только в этом браузере.";
  load();
}
