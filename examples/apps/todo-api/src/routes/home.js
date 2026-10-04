// todo-api home route.
//
// Serves a single self-contained HTML page (no build step, no external assets)
// that exercises the app's own JSON API via fetch. It renders the todo list from
// GET /todos and posts new todos to POST /todos.
//
// This page makes the planted create bug visible in a browser: clicking Add with
// an empty box posts an empty title, which the buggy API still accepts, so a
// blank row visibly appears in the list. After the one-line fix (create returns
// 400 on an empty title), the page shows an inline "title is required" error and
// adds no row. This handler only reads and displays the API; it does not change
// the planted bug or the FABRIC-FOLLOWUP handlers.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>todo-api UI</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  .hint { background: #fffbe6; border: 1px solid #f0e0a0; padding: 0.75rem; border-radius: 6px; }
  .row { display: flex; gap: 0.5rem; margin: 1rem 0; }
  input { flex: 1; padding: 0.5rem; font-size: 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  ul { list-style: none; padding: 0; }
  li { border: 1px solid #ddd; padding: 0.5rem 0.75rem; margin: 0.25rem 0; border-radius: 4px; }
  li .empty { color: #b00; font-style: italic; }
  #error { color: #b00; min-height: 1.2rem; margin: 0.5rem 0; }
</style>
</head>
<body>
<h1>todo-api UI</h1>
<p class="hint">
  Try this: click <strong>Add</strong> with an empty box. With the planted bug,
  a blank todo row is appended (clearly wrong). After the one-line create fix,
  you get a "title is required" error and no row is added instead.
</p>
<div class="row">
  <input id="title" type="text" placeholder="New todo title" />
  <button id="add" type="button">Add</button>
</div>
<div id="error" role="alert"></div>
<ul id="list"></ul>
<script>
  const listEl = document.getElementById("list");
  const titleEl = document.getElementById("title");
  const errorEl = document.getElementById("error");

  function renderTodos(todos) {
    listEl.innerHTML = "";
    for (const todo of todos) {
      const li = document.createElement("li");
      const text = typeof todo.title === "string" ? todo.title : "";
      if (text.length === 0) {
        const span = document.createElement("span");
        span.className = "empty";
        span.textContent = "(empty title)";
        li.appendChild(span);
      } else {
        li.textContent = text;
      }
      listEl.appendChild(li);
    }
  }

  async function loadTodos() {
    errorEl.textContent = "";
    const res = await fetch("/todos");
    const data = await res.json();
    renderTodos(data.todos || []);
  }

  async function addTodo() {
    errorEl.textContent = "";
    const res = await fetch("/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: titleEl.value }),
    });
    if (!res.ok) {
      let message = "request failed";
      try {
        const data = await res.json();
        if (data && typeof data.error === "string") {
          message = data.error;
        }
      } catch {
        message = "request failed";
      }
      errorEl.textContent = message;
      return;
    }
    titleEl.value = "";
    await loadTodos();
  }

  document.getElementById("add").addEventListener("click", addTodo);
  titleEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      addTodo();
    }
  });

  loadTodos();
</script>
</body>
</html>
`;

export function handleHome() {
  return new Response(PAGE, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
