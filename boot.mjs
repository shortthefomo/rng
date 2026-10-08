// Pack rng/boot.js into an AppLoader document. The ledger cap is 4096 bytes.
// The stored page is a deflate-raw blob the browser inflates and evals.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { validate } from "./validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "boot.html");

function stub(b64) {
  // The ledger cap is 4096 bytes. Viewport and the unpack fallback do not fit
  // beside the signer. DecompressionStream is present in the browsers this
  // bootloader is opened in. The script has to sit in the body: the page
  // replaces document.head, and WebKit stops a script that lived in the head
  // before the dice markup is written. The page is then only the green felt.
  return (
    "<!doctype html><html><body><script>" +
    `const z="${b64}";` +
    "new Response(new Response(Uint8Array.from(atob(z),c=>c.charCodeAt())).body" +
    '.pipeThrough(new DecompressionStream("deflate-raw"))).text().then(eval)' +
    "</script></html>"
  );
}

export async function buildDice() {
  const source = fs.readFileSync(path.join(HERE, "bet-sign.js"), "utf8") +
    "\n" + fs.readFileSync(path.join(HERE, "boot.js"), "utf8");
  const js = (
    await esbuild.transform(source, {
      minify: true,
      target: "es2020",
    })
  ).code.trim();
  const b64 = zlib.deflateRawSync(Buffer.from(js), { level: 9 }).toString("base64");
  const doc = stub(b64);
  const buf = Buffer.from(doc);
  const verdict = validate(buf);
  if (verdict !== "ok") throw new Error(`AppLoader rejected the dice page (${verdict}, ${buf.length} bytes)`);
  fs.writeFileSync(OUT, buf);
  return { path: OUT, bytes: buf.length, max: 4096 };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const result = await buildDice();
  process.stdout.write(`${result.bytes} / ${result.max} bytes\n${result.path}\n`);
}
