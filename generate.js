// Builds the Lucide icons as components in the Penpot file that is open.
//
// This is the body of an async function that runs in Penpot's plugin context,
// where `penpot` is the Plugin API. The Penpot MCP server runs it as it is with
// its `execute_code` tool. Run it again and again until it returns
// `{ done: true }`: each run builds what fits into `budgetMs` and takes up
// where the last one stopped, because Penpot grows slower with every shape on
// a page and a single long run would not come back.

const CONFIG = {
  // The version of the package lucide-static the icons are taken from.
  version: "1.61.0",
  // One page for each range of first letters. A page with all icons on it
  // makes Penpot too slow to work on.
  pages: [
    ["a", "o"],
    ["p", "s"],
    ["t", "z"],
  ],
  // How long one run builds before it returns, in milliseconds.
  budgetMs: 8000,
  // Icons in one row of a letter's board.
  columns: 24,
  // The colour of the stroke, and the token that carries it.
  color: "#0A0A0A",
  tokenSet: "Lucide",
  token: "foreground",
};

const SIZE = 24;
const PITCH = 48;
const PADDING = 48;
const BOARD_GAP = 96;

// `storage` outlives a run on the Penpot MCP server. Elsewhere the icons are
// fetched once for each run.
const cache = typeof storage === "object" && storage ? storage : {};

async function loadIcons() {
  const key = `lucide-static@${CONFIG.version}`;
  if (!cache[key]) {
    const url = `https://unpkg.com/lucide-static@${CONFIG.version}/icon-nodes.json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    cache[key] = await response.json();
  }
  return cache[key];
}

function svgOf(nodes) {
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const body = nodes
    .map(([tag, attributes]) => {
      const written = Object.entries(attributes)
        .map(([name, value]) => `${name}="${escape(value === "currentColor" ? CONFIG.color : value)}"`)
        .join(" ");
      return `<${tag} ${written}/>`;
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" ` +
    `fill="none" stroke="${CONFIG.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );
}

function foregroundToken() {
  const catalog = penpot.library.local.tokens;
  let set = catalog.sets.find((candidate) => candidate.name === CONFIG.tokenSet);
  if (!set) set = catalog.addSet({ name: CONFIG.tokenSet });
  if (!set.active) set.toggleActive();
  return (
    set.tokens.find((candidate) => candidate.name === CONFIG.token) ??
    set.addToken({ type: "color", name: CONFIG.token, value: CONFIG.color })
  );
}

function pageName([from, to]) {
  return `Icons ${from.toUpperCase()}–${to.toUpperCase()}`;
}

function letterBoards(page) {
  const boards = new Map();
  for (const child of page.root.children) {
    if (child.type === "board" && /^[A-Z0-9]$/.test(child.name)) boards.set(child.name.toLowerCase(), child);
  }
  return boards;
}

function buildIcon(name, nodes, token, parent, left, top) {
  const drawing = penpot.createShapeFromSvg(svgOf(nodes));
  const icon = penpot.createBoard();
  icon.resize(SIZE, SIZE);
  icon.name = name;
  icon.fills = [];
  icon.clipContent = false;
  parent.appendChild(icon);
  icon.x = parent.x + left;
  icon.y = parent.y + top;
  drawing.x = icon.x;
  drawing.y = icon.y;

  for (const shape of [...drawing.children]) {
    // The import adds a hidden rectangle as large as the drawing.
    if (shape.name === "base-background") {
      shape.remove();
      continue;
    }
    icon.appendChild(shape);
    shape.name = shape.name.replace(/^svg-/, "");
    shape.constraintsHorizontal = "scale";
    shape.constraintsVertical = "scale";
    // The alignment is written before the token is applied: a stroke without
    // one becomes an inner stroke when a token is applied to it, and Lucide
    // draws its strokes on the centre of the path.
    const caps = shape.type === "path" ? { strokeCapStart: "round", strokeCapEnd: "round" } : {};
    shape.strokes = [
      {
        strokeColor: CONFIG.color,
        strokeOpacity: 1,
        strokeStyle: "solid",
        strokeWidth: 2,
        strokeAlignment: "center",
        ...caps,
      },
    ];
    const properties = ["strokeColor"];
    if (shape.fills && shape.fills.length > 0) properties.push("fill");
    shape.applyToken(token, properties);
  }

  // Penpot removes the group itself once it is empty. Where it has not, it
  // goes here.
  try {
    drawing.remove();
  } catch {
    // Already gone.
  }
  penpot.library.local.createComponent([icon]).name = name;
}

// An icon is finished once it is a component. A board that is none is what an
// interrupted run left behind.
function isFinished(icon) {
  return icon.isComponentMainInstance();
}

const started = Date.now();
const icons = await loadIcons();
const token = foregroundToken();
const names = Object.keys(icons).sort();

// What each page is to hold, and what it lacks.
const plan = CONFIG.pages.map((range) => {
  const [from, to] = range;
  const letters = [...new Set(names.map((name) => name[0]))].filter((letter) => letter >= from && letter <= to).sort();
  const page = penpot.currentFile.pages.find((candidate) => candidate.name === pageName(range));
  const boards = page ? letterBoards(page) : new Map();
  const missing = [];
  for (const letter of letters) {
    const present = new Set((boards.get(letter)?.children ?? []).filter(isFinished).map((child) => child.name));
    for (const name of names) if (name[0] === letter && !present.has(name)) missing.push(name);
  }
  return { range, letters, page, missing };
});

const next = plan.find((entry) => entry.missing.length > 0);
if (!next) return { done: true, version: CONFIG.version, icons: names.length };

// The page of this run: the one that exists, or the empty first page of a new
// file, or a new one.
let page = next.page;
if (!page) {
  const untouched = penpot.currentFile.pages.find(
    (candidate) => candidate.root.children.length === 0 && /^Page \d+$/.test(candidate.name),
  );
  page = untouched ?? penpot.createPage();
  page.name = pageName(next.range);
}
if (penpot.currentPage.id !== page.id) await penpot.openPage(page);
page = penpot.currentPage;

// A board for each letter, one below the other.
const boards = letterBoards(page);
for (const board of boards.values()) {
  for (const icon of [...board.children]) if (!isFinished(icon)) icon.remove();
}
let top = 0;
for (const letter of next.letters) {
  const count = names.filter((name) => name[0] === letter).length;
  const rows = Math.ceil(count / CONFIG.columns);
  const height = PADDING * 2 + rows * PITCH - (PITCH - SIZE);
  if (!boards.has(letter)) {
    const board = penpot.createBoard();
    board.name = letter.toUpperCase();
    board.x = 0;
    board.y = top;
    board.resize(PADDING * 2 + CONFIG.columns * PITCH - (PITCH - SIZE), height);
    board.fills = [{ fillColor: "#FFFFFF", fillOpacity: 1 }];
    boards.set(letter, board);
  }
  top += height + BOARD_GAP;
}

let built = 0;
for (const name of next.missing) {
  if (Date.now() - started > CONFIG.budgetMs) break;
  const ofLetter = names.filter((candidate) => candidate[0] === name[0]);
  const index = ofLetter.indexOf(name);
  buildIcon(
    name,
    icons[name],
    token,
    boards.get(name[0]),
    PADDING + (index % CONFIG.columns) * PITCH,
    PADDING + Math.floor(index / CONFIG.columns) * PITCH,
  );
  built += 1;
}

const remaining = plan.reduce((sum, entry) => sum + entry.missing.length, 0) - built;
return { done: remaining === 0, page: page.name, built, remaining };
