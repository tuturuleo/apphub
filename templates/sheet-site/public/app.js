const data = await fetch("data.json").then((r) => r.json());
const table = document.getElementById("table");
const search = document.getElementById("search");

document.getElementById("title").textContent = data.title;
document.getElementById("updated").textContent =
  "Обновлено " + new Date(data.updatedAt).toLocaleString("ru-RU");

function cell(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

function render(query) {
  const q = query.trim().toLowerCase();
  const rows = q ? data.rows.filter((r) => r.some((c) => c.toLowerCase().includes(q))) : data.rows;
  const head = document.createElement("tr");
  head.append(...data.columns.map((c) => cell("th", c)));
  table.replaceChildren(
    head,
    ...rows.map((r) => {
      const tr = document.createElement("tr");
      tr.append(...data.columns.map((_, i) => cell("td", r[i] ?? "")));
      return tr;
    }),
  );
}

search.addEventListener("input", () => render(search.value));
render("");
