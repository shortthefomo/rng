// Sign the demo player's EscrowCreate. The RNG node will not sign a secret.
// Destination is the pot. The signed blob is what the public socket accepts.
const rngHex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
const RNG_PUB = rngHex("EDBCF0424D660A0190E761DFFE704DB3631AE3D2F25D3974C83FCE3904A335A19C");
const RNG_SEED = rngHex("1699E82AD3F6E025ED8C1C73CCD5B8C47FFE5FE84C383EDD9D6B0CA42E30B827");
const RNG_ME = rngHex("3fc0ca5b718fa93e8a8079f39ce942c9fa359d60");
const RNG_POTB = rngHex("c752d9c805bc8dee2e5a0595957e4f0123a3e482");
const RNG_PKCS = rngHex("302e020100300506032b657004220420");
globalThis.rngPlayer = "raFaXQGWPdGPRxsQGKTGzWcksqhA63wxH4";
globalThis.rngPot = "rKwv5khQrtFm22CWmNvMqbgxUANaUAmewB";

function rngU32(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function rngAmt(drops) {
  const v = BigInt(drops) | (1n << 62n);
  const out = [];
  for (let i = 7; i >= 0; i--) out.push(Number((v >> BigInt(i * 8)) & 255n));
  return out;
}
globalThis.rngSign = async (tx) => {
  const head = [
    0x12, 0x00, 0x01,
    0x21, ...rngU32(21339),
    0x24, ...rngU32(tx.Sequence),
    0x2e, ...rngU32(tx.DestinationTag),
    0x20, 0x1b, ...rngU32(tx.LastLedgerSequence),
    0x20, 0x24, ...rngU32(tx.CancelAfter),
    0x20, 0x25, ...rngU32(tx.FinishAfter),
    0x61, ...rngAmt(tx.Amount),
    0x68, ...rngAmt(tx.Fee),
    0x73, RNG_PUB.length, ...RNG_PUB,
  ];
  const tail = [0x81, RNG_ME.length, ...RNG_ME, 0x83, RNG_POTB.length, ...RNG_POTB];
  const core = Uint8Array.from([...head, ...tail]);
  const msg = new Uint8Array(4 + core.length);
  msg.set([0x53, 0x54, 0x58, 0x00]);
  msg.set(core, 4);
  const pkcs8 = new Uint8Array(RNG_PKCS.length + RNG_SEED.length);
  pkcs8.set(RNG_PKCS);
  pkcs8.set(RNG_SEED, RNG_PKCS.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, msg));
  const full = Uint8Array.from([...head, 0x74, sig.length, ...sig, ...tail]);
  return [...full].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
};
