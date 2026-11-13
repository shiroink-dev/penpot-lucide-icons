// Builds the Lucide icons as components in the Penpot file that is open, and
// brings a file built earlier up to another Lucide version.
//
// This is the body of an async function that runs in Penpot's plugin context,
// where `penpot` is the Plugin API. The Penpot MCP server runs it as it is with
// its `execute_code` tool. Run it again and again until it returns
// `{ done: true }`: each run does what fits into `budgetMs` and takes up where
// the last one stopped, because Penpot grows slower with every shape on a page
// and a single long run would not come back.

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
  // How long one run works before it returns, in milliseconds.
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
const BOARD_WIDTH = PADDING * 2 + CONFIG.columns * PITCH - (PITCH - SIZE);

// Where an icon keeps the signature of the drawing it was built from.
const NAMESPACE = "lucide";
const DRAWING = "drawing";

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

// Tells one drawing of an icon from another, so that a run sees which icons
// Lucide has drawn anew since the file was built.
function signature(nodes) {
  const text = JSON.stringify(nodes);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}-${hash.toString(16)}`;
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

function boardHeight(count) {
  const rows = Math.max(1, Math.ceil(count / CONFIG.columns));
  return PADDING * 2 + rows * PITCH - (PITCH - SIZE);
}

function slotOf(index) {
  return {
    left: PADDING + (index % CONFIG.columns) * PITCH,
    top: PADDING + Math.floor(index / CONFIG.columns) * PITCH,
  };
}

// Penpot's positions carry the noise of floating point numbers.
function differs(value, expected) {
  return Math.abs(value - expected) > 0.5;
}

// An icon is finished once it is a component. A board that is none is what an
// interrupted run left behind.
function isFinished(icon) {
  return icon.isComponentMainInstance();
}

function place(icon, board, slot) {
  icon.x = board.x + slot.left;
  icon.y = board.y + slot.top;
}

// Draws the icon into its board and notes which drawing it is.
function draw(icon, nodes, token) {
  const drawing = penpot.createShapeFromSvg(svgOf(nodes));
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
  icon.setSharedPluginData(NAMESPACE, DRAWING, signature(nodes));
}

function buildIcon(name, nodes, token, board, slot) {
  const icon = penpot.createBoard();
  icon.resize(SIZE, SIZE);
  icon.name = name;
  icon.fills = [];
  icon.clipContent = false;
  board.appendChild(icon);
  place(icon, board, slot);
  draw(icon, nodes, token);
  penpot.library.local.createComponent([icon]).name = name;
}

// The component stays the one it was, so every copy in a design keeps its
// link, and only the drawing inside is exchanged.
function redrawIcon(icon, nodes, token) {
  for (const shape of [...icon.children]) shape.remove();
  draw(icon, nodes, token);
}

const started = Date.now();
const spent = () => Date.now() - started > CONFIG.budgetMs;
const icons = await loadIcons();
const token = foregroundToken();
const names = Object.keys(icons).sort();
const signatures = new Map(names.map((name) => [name, signature(icons[name])]));

// What a page is to hold and what stands in the way: icons that are missing,
// icons Lucide has drawn anew, icons and boards that are not in their place.
// An icon Lucide no longer has is left alone, moved behind the others of its
// letter and reported, because designs may still use it.
function survey(range) {
  const [from, to] = range;
  const inRange = (letter) => letter >= from && letter <= to;
  const page = penpot.currentFile.pages.find((candidate) => candidate.name === pageName(range));
  const boards = page ? letterBoards(page) : new Map();
  const letters = [...new Set([...names.map((name) => name[0]), ...boards.keys()])].filter(inRange).sort();

  const work = { range, page, missing: [], stale: [], misplaced: [], boards: [], dropped: [] };
  let top = 0;
  for (const letter of letters) {
    const board = boards.get(letter);
    const present = new Map((board?.children ?? []).filter(isFinished).map((icon) => [icon.name, icon]));
    const dropped = [...present.keys()].filter((name) => !signatures.has(name)).sort();
    const order = [...names.filter((name) => name[0] === letter), ...dropped];
    const height = boardHeight(order.length);

    const inPlace =
      board &&
      !differs(board.x, 0) &&
      !differs(board.y, top) &&
      !differs(board.width, BOARD_WIDTH) &&
      !differs(board.height, height);
    if (!inPlace) work.boards.push({ letter, top, height });

    order.forEach((name, index) => {
      const icon = present.get(name);
      const slot = slotOf(index);
      if (!icon) {
        work.missing.push({ name, letter, slot });
        return;
      }
      if (signatures.has(name) && icon.getSharedPluginData(NAMESPACE, DRAWING) !== signatures.get(name)) {
        work.stale.push({ name, icon });
      }
      if (differs(icon.parentX, slot.left) || differs(icon.parentY, slot.top)) {
        work.misplaced.push({ icon, letter, slot });
      }
    });
    work.dropped.push(...dropped);
    top += height + BOARD_GAP;
  }
  return work;
}

const count = (work) => work.missing.length + work.stale.length + work.misplaced.length + work.boards.length;

const plan = CONFIG.pages.map(survey);
const dropped = plan.flatMap((work) => work.dropped);
const first = plan.find((work) => count(work) > 0);
if (!first) return { done: true, version: CONFIG.version, icons: names.length, dropped };

// The page of this run: the one that exists, or the empty first page of a new
// file, or a new one.
let page = first.page;
if (!page) {
  const untouched = penpot.currentFile.pages.find(
    (candidate) => candidate.root.children.length === 0 && /^Page \d+$/.test(candidate.name),
  );
  page = untouched ?? penpot.createPage();
  page.name = pageName(first.range);
}
if (penpot.currentPage.id !== page.id) await penpot.openPage(page);
page = penpot.currentPage;

// Only the page that is open can be changed, so it is looked at once more now
// that it is.
const boards = letterBoards(page);
for (const board of boards.values()) {
  for (const icon of [...board.children]) if (!isFinished(icon)) icon.remove();
}
const work = survey(first.range);

for (const { letter, top, height } of work.boards) {
  let board = boards.get(letter);
  if (!board) {
    board = penpot.createBoard();
    board.name = letter.toUpperCase();
    board.fills = [{ fillColor: "#FFFFFF", fillOpacity: 1 }];
    boards.set(letter, board);
  }
  board.x = 0;
  board.y = top;
  board.resize(BOARD_WIDTH, height);
}

let built = 0;
for (const { name, letter, slot } of work.missing) {
  if (spent()) break;
  buildIcon(name, icons[name], token, boards.get(letter), slot);
  built += 1;
}

let redrawn = 0;
for (const { name, icon } of work.stale) {
  if (spent()) break;
  redrawIcon(icon, icons[name], token);
  redrawn += 1;
}

let moved = 0;
for (const { icon, letter, slot } of work.misplaced) {
  if (spent()) break;
  place(icon, boards.get(letter), slot);
  moved += 1;
}

const elsewhere = plan.filter((other) => other !== first).reduce((sum, other) => sum + count(other), 0);
const here = count(work) - work.boards.length - built - redrawn - moved;
const remaining = elsewhere + here;
return { done: remaining === 0, page: page.name, built, redrawn, moved, remaining, dropped };
