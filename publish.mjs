// Store the dice boot document as an AppLoader on the PWA devnet.
//   node publish.mjs
//
//   ws:      wss://pwapp.xahau-dev.net
//   rpc:     https://rpc.pwapp.xahau-dev.net
//   faucet:  https://faucet.pwapp.xahau-dev.net/accounts
//   loader:  https://pwa.pwapp.xahau-dev.net/<account>
//   network: 21339
//
// Set XAHAU_SEED to publish onto an existing account instead of the faucet.
// Bets still settle on the RNG devnet. This only updates the page.

import fs from "node:fs";
import path from "node:path";
import { binary, derive, signAndSubmit, utils, XrplClient, XrplDefinitions } from "xrpl-accountlib";
import { buildDice } from "./boot.mjs";

const WSS = process.env.XAHAU_WSS || "wss://pwapp.xahau-dev.net";
const FAUCET = process.env.XAHAU_FAUCET || "https://faucet.pwapp.xahau-dev.net/accounts";
const PWA = (process.env.XAHAU_PWA || "https://pwa.pwapp.xahau-dev.net").replace(/\/$/, "");
const NETWORK_ID = Number(process.env.XAHAU_NETWORK_ID || 21339);

function log(...args) {
  process.stdout.write(args.map(String).join(" ") + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function faucetAccount() {
  if (process.env.XAHAU_SEED) {
    const wallet = derive.familySeed(process.env.XAHAU_SEED);
    return { wallet, address: wallet.address, secret: process.env.XAHAU_SEED, minted: false };
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(FAUCET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    if (body.account?.secret) {
      const wallet = derive.familySeed(body.account.secret);
      const address = body.account.classicAddress || body.account.address;
      if (wallet.address !== address) throw new Error(`seed derived ${wallet.address}, faucet said ${address}`);
      return { wallet, address, secret: body.account.secret, minted: true, balance: body.balance };
    }
    const msg = JSON.stringify(body);
    log("faucet retry", attempt, msg);
    if (/wait|rate/i.test(msg)) {
      await sleep(65000);
      continue;
    }
    throw new Error("faucet failed: " + msg);
  }
  throw new Error("faucet failed after retries");
}

async function waitAccount(client, address) {
  for (let i = 0; i < 40; i++) {
    try {
      return await client.send({ command: "account_info", account: address, ledger_index: "validated" });
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("account was not in a validated ledger");
}

async function feeDrops(client, bytes) {
  const quoted = await client.send({ command: "fee" });
  const drops = quoted.drops || quoted.result?.drops;
  const base = Number(drops.base_fee || drops.minimum_fee);
  const open = Number(drops.open_ledger_fee || drops.minimum_fee);
  const scale = Math.max(1, Math.ceil(open / base));
  return (base + bytes) * scale;
}

const built = await buildDice();
const html = fs.readFileSync(built.path);
log("document", path.basename(built.path), built.bytes, "bytes");

const owner = await faucetAccount();
log("account", owner.address, owner.minted ? "faucet" : "existing");

const client = new XrplClient(WSS);
try {
  await waitAccount(client, owner.address);
  const rawDefs = await client.definitions();
  if (!rawDefs || typeof rawDefs.FIELDS !== "object") throw new Error("server_definitions did not include FIELDS");
  const definitions = new XrplDefinitions(rawDefs);
  const loader = html.toString("hex").toUpperCase();
  let fee = await feeDrops(client, html.length);
  log("fee", fee, "drops");
  let published = false;

  for (let attempt = 0; attempt < 3 && !published; attempt++) {
    const net = await utils.txNetworkAndAccountValues(client, owner.wallet);
    const tx = {
      TransactionType: "AccountSet",
      Account: owner.address,
      NetworkID: NETWORK_ID,
      Sequence: net.txValues.Sequence,
      Fee: String(fee),
      LastLedgerSequence: (net.networkInfo.ledgerSequence || 0) + 60,
      AppLoader: loader,
    };
    const round = binary.decode(binary.encode(tx, definitions), definitions);
    const back = Buffer.from(String(round.AppLoader), "hex");
    if (!back.equals(html)) throw new Error("codec round-trip changed the document");

    const submitted = await signAndSubmit(tx, client, owner.wallet);
    const response = submitted.response || {};
    const prelim = response.engine_result || response.error || "unknown";
    log("submit", prelim, response.engine_result_message || "", submitted.tx_id);
    if (prelim === "telINSUF_FEE_P") {
      fee *= 2;
      log("raise fee", fee);
      continue;
    }
    if (!/^(tes|tec)/.test(prelim)) throw new Error(prelim + " " + (response.engine_result_message || ""));

    let validated = null;
    for (let i = 0; i < 30; i++) {
      try {
        const looked = await client.send({ command: "tx", transaction: submitted.tx_id, binary: false });
        if (looked.validated) {
          validated = looked;
          break;
        }
      } catch {
        // Not in a ledger yet.
      }
      await sleep(1000);
    }
    const result = validated?.meta?.TransactionResult || validated?.metadata?.TransactionResult;
    if (result !== "tesSUCCESS") throw new Error("validated result " + (result || "missing"));
    log("validated", submitted.tx_id);

    const entry = await client.send({
      command: "ledger_entry",
      app_loader: owner.address,
      ledger_index: "validated",
    });
    const node = entry.node || entry.result?.node;
    if (!node || node.LedgerEntryType !== "AppLoader") throw new Error("ledger_entry did not return AppLoader");
    const stored = Buffer.from(String(node.AppLoader), "hex");
    if (!stored.equals(html)) throw new Error(`ledger blob does not match ${path.basename(built.path)}`);

    const page = PWA + "/" + owner.address;
    let served = null;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(page);
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && body.equals(html)) {
        served = res;
        break;
      }
      log("serve retry", res.status, body.subarray(0, 120).toString());
      await sleep(1500);
    }
    if (!served) throw new Error("loader URL did not serve the document");
    log("url", page);
    log("seed", owner.secret);
    published = true;
  }
  if (!published) throw new Error("AccountSet did not land");
} finally {
  client.close();
}
