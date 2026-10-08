// Headless Chrome check for the dice page: six faces, a 10 XAH cap, and a
// local signature of one known EscrowCreate. offline=1 never opens a socket,
// so Place bet cannot submit.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MATCH = "120001210000535B243259D11F2E00000004201B004C4B402024325A03E82025325A03C0614000000000989680684000000000004E207321EDBCF0424D660A0190E761DFFE704DB3631AE3D2F25D3974C83FCE3904A335A19C7440654D86CF86163281BF65D3DD5C534F3E29A69ADB9F31583ABD0865FE9F3B53913B89418581BCE094B04C893D7698207069FF6CA9A69F43C0B9914C00359C380B81143FC0CA5B718FA93E8A8079F39CE942C9FA359D608314C752D9C805BC8DEE2E5A0595957E4F0123A3E482";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HOOK = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

let failed = 0;

function assert(cond, message) {
  if (!cond) {
    failed++;
    process.stderr.write("FAIL " + message + "\n");
  } else {
    process.stdout.write("PASS " + message + "\n");
  }
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentType(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/html; charset=utf-8";
}

const server = await listen((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
  const file = path.join(HERE, name);
  if (!file.startsWith(HERE) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end("missing");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(file) });
  res.end(fs.readFileSync(file));
});

if (!fs.existsSync(CHROME)) {
  console.log("browser: Chrome is not installed, UI was not exercised");
  server.close();
  process.exit(1);
}
const webPort = server.address().port;
const debugPort = await freePort();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rng-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${dir}`,
  `http://127.0.0.1:${webPort}/?offline=1`,
], { stdio: ["ignore", "pipe", "pipe"] });

let debugLog = "";
const take = (chunk) => {
  debugLog += chunk.toString();
};
chrome.stdout.on("data", take);
chrome.stderr.on("data", take);

try {
  for (let i = 0; i < 150 && !debugLog.includes("DevTools listening"); i++) await sleep(100);
  assert(debugLog.includes("DevTools listening"), "Chrome debug port opened");
  if (!debugLog.includes("DevTools listening")) throw new Error("no devtools");

  let targets = [];
  for (let i = 0; i < 50 && targets.length === 0; i++) {
    const listed = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    targets = (await listed.json()).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!targets.length) await sleep(100);
  }
  assert(targets.length > 0, "Chrome opened a page");
  if (!targets.length) throw new Error("no page");

  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  let ready = false;
  for (let i = 0; i < 50; i++) {
    const probe = await send("Runtime.evaluate", {
      expression: `document.querySelectorAll(".face").length === 6 && !!window.__rng`,
      returnByValue: true,
    });
    if (probe.result?.value === true) {
      ready = true;
      break;
    }
    await sleep(100);
  }
  assert(ready, "six faces are on the page");
  if (!ready) {
    const dumped = await send("Runtime.evaluate", {
      expression: `document.body ? document.body.innerText.slice(0, 500) : document.documentElement.outerHTML.slice(0, 500)`,
      returnByValue: true,
    });
    process.stderr.write("page text: " + JSON.stringify(dumped.result?.value) + "\n");
    throw new Error("page did not start");
  }

  const built = await send("Runtime.evaluate", {
    expression: `(() => {
      const bet = document.getElementById("bet");
      bet.value = "999";
      bet.dispatchEvent(new Event("input"));
      const maxDrops = window.__rng.drops();
      const maxLabel = document.getElementById("amount").textContent;
      bet.value = "1";
      bet.dispatchEvent(new Event("input"));
      const minDrops = window.__rng.drops();
      bet.value = "100";
      bet.dispatchEvent(new Event("input"));
      document.getElementById("account").value = ${JSON.stringify(HOOK)};
      document.querySelector('[data-face="4"]').click();
      const picked = document.querySelector('[data-face="4"]');
      return {
        maxDrops,
        maxLabel,
        minDrops,
        clock: document.getElementById("clock").dataset.clock,
        faces: document.querySelectorAll(".face").length,
        picked: picked.getAttribute("aria-pressed") === "true" && picked.innerText.includes("picked"),
        others: [...document.querySelectorAll(".face")].filter((el) => el !== picked).every((el) => el.getAttribute("aria-pressed") === "false"),
        house: !!document.getElementById("house-amt"),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const setup = built.result?.value;
  assert(setup?.faces === 6, "face count stays 6");
  assert(setup?.picked === true && setup?.others === true, "the chosen die is marked picked");
  assert(setup?.house === true, "the house total is on the page");
  assert(setup?.maxDrops === 10000000, "slider caps at 10000000 drops, got " + setup?.maxDrops);
  assert(setup?.maxLabel === "10.0 XAH", "max label is 10.0 XAH, got " + setup?.maxLabel);
  assert(setup?.minDrops === 100000, "minimum step is 100000 drops, got " + setup?.minDrops);
  assert(setup?.clock === "wall", "offline page uses the wall clock, got " + setup?.clock);

  const shown = await send("Runtime.evaluate", {
    expression: `(async () => {
      const potOnly = document.getElementById("account").value;
      document.getElementById("show").click();
      await new Promise((r) => setTimeout(r, 20));
      const refused = document.getElementById("status").textContent;
      document.getElementById("account").value = rngPot;
      document.getElementById("show").click();
      await new Promise((r) => setTimeout(r, 20));
      return {
        potOnly,
        refused,
        status: document.getElementById("status").textContent,
        known: document.getElementById("result").dataset.known,
        xaman: /xaman|xumm/i.test(document.body.innerText),
        secret: document.body.innerText.includes("sEdT"),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const page = shown.result?.value;
  assert(page?.known === "0", "the result die stays unknown before a ledger string");
  assert(page?.xaman === false, "the page does not mention Xaman");
  assert(page?.secret === false, "the page does not show the player seed");
  assert(page?.potOnly === HOOK, "the account field accepted the test address");
  assert(page?.refused === "This demo signs only to the pot.", "a different destination is refused, got " + page?.refused);
  assert(page?.status === "Not connected.", "offline Place bet does not submit, got " + page?.status);

  const wallet = await send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.getElementById("wallet-amt");
      const start = el.textContent;
      showBal("983000000");
      const base = el.textContent;
      showBal("984000000");
      const up = { text: el.textContent, cls: el.className };
      showBal("982000000");
      const down = { text: el.textContent, cls: el.className };
      return { start, base, up, down };
    })()`,
    returnByValue: true,
  });
  const bal = wallet.result?.value;
  assert(bal?.start === "…", "wallet starts blank, got " + bal?.start);
  assert(bal?.base === "983.00 XAH", "wallet shows XAH, got " + bal?.base);
  assert(bal?.up?.text === "984.00 XAH" && bal?.up?.cls === "up", "a higher balance is green, got " + JSON.stringify(bal?.up));
  assert(bal?.down?.text === "982.00 XAH" && bal?.down?.cls === "down", "a lower balance is red, got " + JSON.stringify(bal?.down));

  const progress = await send("Runtime.evaluate", {
    expression: `(async () => {
      say("idle");
      const empty = document.getElementById("status").textContent;
      window.__rng.arm((Math.floor(Date.now() / 1000) - 946684800) + 25);
      const armed = document.getElementById("status").textContent;
      say("wait");
      say("idle");
      const during = document.getElementById("status").textContent;
      startRoll();
      await new Promise((r) => setTimeout(r, 150));
      const die = document.getElementById("result");
      const spinning = die.classList.contains("rolling");
      const moving = die.dataset.face !== "0";
      say("face=3 loss");
      const dots = [...die.querySelectorAll("i")].map((dot) => getComputedStyle(dot).opacity);
      const result = document.getElementById("status").textContent;
      say("idle");
      say("done");
      const kept = document.getElementById("status").textContent;
      say("time window");
      const keptError = document.getElementById("status").textContent;
      return {
        empty,
        armed,
        during,
        spinning,
        moving,
        result,
        landed: die.dataset.face,
        still: !die.classList.contains("rolling"),
        dots: dots.join(","),
        kept,
        keptError,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const step = progress.result?.value;
  assert(step?.empty === "The table is empty.", "an empty table says so before a bet, got " + step?.empty);
  assert(step?.armed.startsWith("Escrow created"), "a bet shows escrow created, got " + step?.armed);
  assert(step?.during.startsWith("Escrow created"), "idle does not cover the countdown, got " + step?.during);
  assert(step?.result.includes("Face 3"), "the result names the face, got " + step?.result);
  assert(step?.spinning === true && step?.moving === true, "place bet spins the die, got " + step?.spinning + " " + step?.moving);
  assert(step?.landed === "3" && step?.still === true, "the roll stops on the face, got " + step?.landed);
  assert(step?.dots === "1,0,0,0,1,0,0,0,1", "face 3 shows the diagonal pips, got " + step?.dots);
  assert(step?.kept === step?.result, "idle after the result leaves the face, got " + step?.kept);
  assert(step?.keptError === step?.result, "a later hook string leaves the face, got " + step?.keptError);
  const bootSrc = fs.readFileSync(path.join(HERE, "boot.js"), "utf8");
  const pageSrc = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
  assert(bootSrc.includes("const start = closeT + 20") && bootSrc.includes("CancelAfter: start + 20"), "boot waits 20s then 20s");
  assert(pageSrc.includes("const start = closeT + 20") && pageSrc.includes("CancelAfter: start + 20"), "page waits 20s then 20s");

  const signed = await send("Runtime.evaluate", {
    expression: `rngSign({
      Amount: "10000000",
      DestinationTag: 4,
      FinishAfter: 844760000,
      CancelAfter: 844760040,
      Sequence: 844747039,
      Fee: "20000",
      LastLedgerSequence: 5000000,
    })`,
    returnByValue: true,
    awaitPromise: true,
  });
  assert(signed.result?.value === MATCH, "the page signature matches the known escrow blob");

  await send("Runtime.evaluate", {
    expression: `(() => {
      const bet = document.getElementById("bet");
      bet.value = "25";
      bet.dispatchEvent(new Event("input"));
      document.querySelector('[data-face="4"]').click();
    })()`,
    awaitPromise: true,
  });

  async function shot(name, width, height, mobile) {
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile,
    });
    await sleep(200);
    const png = await send("Page.captureScreenshot", { format: "png" });
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, Buffer.from(png.data, "base64"));
    return file;
  }

  const desktop = await shot("rng-desktop.png", 1280, 900, false);
  const overflow = await send("Runtime.evaluate", {
    expression: `document.documentElement.scrollWidth <= window.innerWidth + 1`,
    returnByValue: true,
  });
  const mobile = await shot("rng-mobile.png", 390, 844, true);
  const mobileOverflow = await send("Runtime.evaluate", {
    expression: `({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      faces: document.querySelectorAll(".face").length,
      place: document.getElementById("show").textContent
    })`,
    returnByValue: true,
  });
  assert(overflow.result?.value === true, "desktop does not overflow");
  assert(mobileOverflow.result?.value?.overflow === true, "mobile does not overflow");
  assert(mobileOverflow.result?.value?.faces === 6, "mobile still has six faces");
  assert(mobileOverflow.result?.value?.place === "Place bet", "mobile still offers Place bet");
  process.stdout.write("screenshots " + desktop + " " + mobile + "\n");
  ws.close();
} finally {
  chrome.kill();
  server.close();
  await sleep(400);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failed) {
  process.stderr.write(failed + " failed\n");
  process.exit(1);
}
process.stdout.write("page checks passed\n");
