const WSS = "wss://rng.xahau-dev.net";
const RIP = 946684800;
document.head.innerHTML =
  "<style>body{background:#08261e;color:#f3ead7;text-align:center}" +
  "button{font-size:32px;background:#f3ead7;color:#111;border:0}" +
  ".p{outline:8px solid #111;font-size:64px}#r{font-size:64px}" +
  ".w{color:#9d9}.l{color:#e99}</style>";
document.body.innerHTML =
  "<p style=text-align:left>You <b id=w>…</b><span style=float:right>House <b id=h>…</b></span></p>" +
  "<b id=r>?</b><div id=f></div>" +
  "<p>Bet <b id=a></b></p><input id=b type=range min=1 max=100 value=10>" +
  "<button id=go>Bet</button><p id=s>";

const faces = document.getElementById("f");
const bet = document.getElementById("b");
const stat = document.getElementById("s");
const pot = globalThis.rngPot;
const player = globalThis.rngPlayer;
let guess = 1;
let close = 0;
let since = 0;
let balAt = 0;
const prev = { w: 0, h: 0 };
let till = 0;
let held = 0;
let ws = null;
let rpcN = 10;
const waits = new Map();
const DIE = "⚀⚁⚂⚃⚄⚅";
const die = document.getElementById("r");
let k = 0;

function faceOf(n) {
  return DIE[n - 1] || "?";
}
function spin(on) {
  die.className = on ? "on" : "";
  if (!on && !held) die.textContent = "?";
}
setInterval(() => {
  if (die.className && !held) die.textContent = DIE[k++ % 6];
  if (!till || held) return;
  const n = till - (close || (Date.now() / 1000 | 0) - RIP);
  if (n > 0) stat.textContent = "Escrow " + n + "s";
}, 100);

for (let n = 1; n <= 6; n++) {
  const b = document.createElement("button");
  b.textContent = faceOf(n);
  b.className = n === 1 ? "p" : "";
  b.onclick = () => {
    guess = n;
    for (const o of faces.children) o.className = o === b ? "p" : "";
  };
  faces.append(b);
}
function tenths() {
  const n = Math.round(Number(bet.value));
  return Math.min(100, Math.max(1, Number.isFinite(n) ? n : 10));
}
function drops() {
  return tenths() * 100000;
}
function amount() {
  document.getElementById("a").textContent = (tenths() / 10).toFixed(1) + " XAH";
}
function showBal(id, v) {
  const n = Number(v);
  const el = document.getElementById(id);
  el.textContent = (n / 1e6).toFixed(2);
  if (prev[id] && n !== prev[id]) el.className = n > prev[id] ? "w" : "l";
  prev[id] = n;
}
function rpc(body) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject();
    const id = ++rpcN;
    const timer = setTimeout(() => { waits.delete(id); reject(); }, 8000);
    waits.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ ...body, id }));
  });
}
bet.oninput = () => amount();
document.getElementById("go").onclick = async () => {
  stat.className = "";
  held = 0;
  spin(1);
  stat.textContent = "Signing";
  let info, led;
  try {
    info = await rpc({ command: "account_info", account: player, ledger_index: "current" });
    led = await rpc({ command: "ledger", ledger_index: "validated" });
  } catch {
    spin(0);
    stat.textContent = "Offline";
    return;
  }
  const seq = info.result?.account_data?.Sequence;
  const index = led.result?.ledger?.ledger_index;
  const closeT = led.result?.ledger?.close_time || close || Math.floor(Date.now() / 1000) - RIP;
  if (!seq || !index) {
    spin(0);
    stat.textContent = "Ledger";
    return;
  }
  const start = closeT + 20;
  let blob;
  try {
    blob = await rngSign({
      Amount: String(drops()),
      DestinationTag: guess,
      FinishAfter: start,
      CancelAfter: start + 20,
      Sequence: seq,
      Fee: "50000",
      LastLedgerSequence: index + 40,
    });
  } catch {
    spin(0);
    stat.textContent = "Sign";
    return;
  }
  let sub;
  try {
    sub = await rpc({ command: "submit", tx_blob: blob });
  } catch {
    spin(0);
    stat.textContent = "Submit";
    return;
  }
  const result = sub.result || {};
  const code = result.engine_result || result.error || "sent";
  if (String(code).startsWith("tes")) {
    held = 0;
    till = start + 20;
    stat.className = "";
    stat.textContent = "Escrow";
  } else {
    till = 0;
    spin(0);
    stat.textContent = code;
  }
  since = index;
  watch();
};
function textOf(ex) {
  let text = ex.HookReturnString || "";
  if (/^[0-9a-f]+$/i.test(text)) text = text.replace(/../g, (h) => String.fromCharCode(parseInt(h, 16)));
  return text.replace(/\0/g, "");
}
function say(text) {
  const face = /^face=([1-6]) (win|loss|refund)$/.exec(text);
  if (face) {
    held = 1;
    till = 0;
    spin(0);
    die.textContent = faceOf(Number(face[1]));
    stat.className = face[2] === "loss" ? "l" : "w";
    stat.textContent = face[2];
    return;
  }
  if (held || (text.length < 9 && text !== "entropy")) return;
  till = 0;
  spin(0);
  stat.className = "";
  if (text) stat.textContent = text;
}
function executions(meta) {
  return ((meta && meta.HookExecutions) || []).map((entry) => textOf(entry.HookExecution || entry)).filter(Boolean);
}
function ingest(meta, hash, ledger) {
  if (ledger && since && ledger <= since) return;
  for (const text of executions(meta)) say(text);
}
function watch() {
  if (!ws || ws.readyState !== 1 || !since) return;
  ws.send(JSON.stringify({ command: "subscribe", accounts: [pot] }));
}
function connect() {
  ws = new WebSocket(WSS);
  ws.onopen = () => {
    ws.send(JSON.stringify({ command: "ledger", ledger_index: "validated", id: 1 }));
    ws.send(JSON.stringify({ command: "subscribe", streams: ["ledger"] }));
    if (since) watch();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && waits.has(msg.id)) {
      const done = waits.get(msg.id);
      waits.delete(msg.id);
      done(msg);
    }
    const led = msg.result?.ledger;
    const t = led?.close_time ?? msg.ledger_time;
    if (typeof t === "number" && t > 1e6) close = t;
    const bal = msg.result?.account_data?.Balance;
    if (bal && (msg.id === 7 || msg.id === 8)) showBal(msg.id === 7 ? "w" : "h", bal);
    const idx = msg.ledger_index || led?.ledger_index;
    if (idx && idx !== balAt && ws.readyState === 1) {
      balAt = idx;
      for (const [account, id] of [[player, 7], [pot, 8]]) {
        ws.send(JSON.stringify({ command: "account_info", account, ledger_index: "validated", id }));
      }
    }
    if (msg.id === 1 && led?.ledger_index && !since) {
      since = led.ledger_index;
      watch();
    }
    if (msg.transaction) ingest(msg.meta, msg.transaction.hash, msg.ledger_index);
  };
  ws.onclose = () => setTimeout(connect, 2000);
}
amount();
connect();
