const list = document.getElementById("notes");
const form = document.getElementById("form");
const input = document.getElementById("text");

async function load() {
  const notes = await fetch("/api/notes").then((r) => r.json());
  list.replaceChildren(
    ...notes.map((note) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = note.text;
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Удалить";
      del.onclick = async () => {
        await fetch(`/api/notes/${note.id}`, { method: "DELETE" });
        load();
      };
      li.append(text, del);
      return li;
    }),
  );
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: input.value }),
  });
  input.value = "";
  load();
});

load();
