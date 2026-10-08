// Install rng_dice.wasm on the RNG devnet and play one escrow.
//
//   ws:      wss://rng.xahau-dev.net
//   rpc:     https://rpc.rng.xahau-dev.net
//   faucet:  https://faucet.rng.xahau-dev.net/accounts
//   network: 21339
//
// The root devnet does not enable the RNG amendment. dice() is whitelisted
// only when it is on. Seeds are printed here and are not written to disk.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  derive,
  signAndSubmit,
  utils,
  XrplClient,
} from "xrpl-accountlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(HERE, "rng_dice.wasm");
const HOOK_JSON = path.join(HERE, "hook.json");
const WSS = process.env.XAHAU_WSS || "wss://rng.xahau-dev.net";
const FAUCET = process.env.XAHAU_FAUCET || "https://faucet.rng.xahau-dev.net/accounts";
const NETWORK_ID = Number(process.env.XAHAU_NETWORK_ID || 21339);
const TX_FEE = "2000000";
const NAMESPACE = "524E474449434500000000000000000000000000000000000000000000000000";
const HOOK_ON = "0".repeat(64);

const results = [];

function log(...args) {
  process.stdout.write(args.map(String).join(" ") + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function txResult(res) {
  return (
    res?.result?.meta?.TransactionResult ||
    res?.result?.metadata?.TransactionResult ||
    res?.result?.engine_result ||
    res?.engine_result ||
    "unknown"
  );
}

function engineMessage(res) {
  return (
    res?.result?.engine_result_message ||
    res?.engine_result_message ||
    res?.result?.error_message ||
    ""
  );
}

function hookExecutions(res) {
  const meta = res?.result?.meta || res?.result?.metadata || res?.meta || {};
  const execs = meta.HookExecutions || [];
  return execs.map((entry) => {
    const ex = entry.HookExecution || entry;
    let text = ex.HookReturnString || "";
    if (text && /^[0-9A-Fa-f]+$/.test(text) && text.length % 2 === 0)
      text = Buffer.from(text, "hex").toString("utf8");
    return text.replace(/\0+$/, "");
  });
}

function record(name, ok, got) {
  results.push({ name, ok, got });
  log(ok ? "PASS" : "FAIL", name, got);
  return ok;
}

function accountFromSeed(secret) {
  const wallet = derive.familySeed(secret);
  log("reuse", wallet.address);
  log("seed", secret);
  return { wallet, address: wallet.address, secret };
}

async function faucetAccount(existingSecret) {
  if (existingSecret) return accountFromSeed(existingSecret);
  for (let attempt = 0; attempt < 6; attempt++) {
    let response;
    try {
      response = await fetch(FAUCET, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch (error) {
      throw new Error("faucet connection failed: " + error.message);
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 404) throw new Error("faucet 404: " + FAUCET);
    if (body.account?.secret) {
      const wallet = derive.familySeed(body.account.secret);
      const address = body.account.classicAddress || body.account.address;
      if (wallet.address !== address)
        throw new Error(`seed derived ${wallet.address}, faucet said ${address}`);
      log("funded", address, "balance", body.balance ?? "");
      log("seed", body.account.secret);
      return { wallet, address, secret: body.account.secret, balance: body.balance };
    }
    const msg = JSON.stringify(body);
    log("faucet retry", attempt, response.status, msg);
    if (response.status === 429 || /wait|rate/i.test(msg)) {
      await sleep(65000);
      continue;
    }
    throw new Error("faucet failed: " + msg);
  }
  throw new Error("faucet failed after retries");
}

async function preparedTx(client, wallet, tx) {
  const net = await utils.txNetworkAndAccountValues(client, wallet);
  return {
    ...tx,
    Account: wallet.address,
    NetworkID: NETWORK_ID,
    Sequence: tx.Sequence ?? net.txValues.Sequence,
    Fee: tx.Fee || TX_FEE,
    LastLedgerSequence: tx.LastLedgerSequence ?? (net.networkInfo.ledgerSequence || 0) + 120,
  };
}

async function submit(client, wallet, tx) {
  const prepared = await preparedTx(client, wallet, tx);
  const submitted = await signAndSubmit(prepared, client, wallet);
  const response = submitted.response || {};
  const prelim = response.engine_result || response.error || "unknown";
  log(
    "submit",
    tx.TransactionType,
    "seq",
    prepared.Sequence,
    "fee",
    prepared.Fee,
    submitted.tx_id
  );
  log("  prelim", prelim, response.engine_result_message || "");
  const packed = { result: response, hash: submitted.tx_id, sequence: prepared.Sequence };
  const applied = /^(tes|tec)/.test(prelim);
  const retry = /terQUEUED|terPRE_SEQ|terRETRY/.test(prelim);
  if (!applied && !retry) return packed;

  for (let i = 0; i < 30; i++) {
    try {
      const txr = await client.send({
        command: "tx",
        transaction: submitted.tx_id,
        binary: false,
      });
      if (txr.validated) {
        const out = { result: txr, hash: submitted.tx_id, sequence: prepared.Sequence };
        log("  ->", txResult(out), hookExecutions(out).join(" | "));
        return out;
      }
    } catch {
      // Not in a ledger yet.
    }
    await sleep(1000);
  }
  log("  -> not validated", prelim);
  return packed;
}

async function submitScalingFee(client, wallet, tx) {
  let fee = BigInt(tx.Fee);
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await submit(client, wallet, { ...tx, Fee: fee.toString() });
    const prelim = last.result?.engine_result || txResult(last);
    if (prelim !== "telINSUF_FEE_P") return last;
    fee *= 2n;
    log("fee doubled", fee.toString());
  }
  return last;
}

async function waitForAccount(client, address) {
  for (let i = 0; i < 30; i++) {
    try {
      const info = await client.send({
        command: "account_info",
        account: address,
        ledger_index: "validated",
      });
      if (info.account_data) return info.account_data;
    } catch {
      // Funding payment has not validated yet.
    }
    await sleep(2000);
  }
  throw new Error("account was not funded: " + address);
}

async function balanceOf(client, address) {
  const info = await client.send({
    command: "account_info",
    account: address,
    ledger_index: "validated",
  });
  return BigInt(info.account_data.Balance);
}

const LSF_TSH_COLLECT = 0x02000000;
const BET_STATE_KEY = "00".repeat(29) + "424554";

async function accountFlags(client, address) {
  const info = await client.send({
    command: "account_info",
    account: address,
    ledger_index: "validated",
  });
  return Number(info.account_data.Flags || 0);
}

async function readHookState(client, address) {
  let res;
  try {
    res = await client.send({
      command: "ledger_entry",
      hook_state: {
        account: address,
        key: BET_STATE_KEY,
        namespace_id: NAMESPACE,
      },
      ledger_index: "validated",
    });
  } catch (error) {
    const text = String(error?.message || error);
    if (/entryNotFound|objectNotFound/i.test(text)) return null;
    throw error;
  }
  if (!res || res.error || res.status === "error") return null;
  const node = res.node || res.result?.node;
  if (!node?.HookStateData) return null;
  return node;
}

async function enableCollect(client, hook) {
  const flags = await accountFlags(client, hook.address);
  if (flags & LSF_TSH_COLLECT) {
    log("tshCollect already set", flags);
    record("allow weak cron hooks", true, "already set " + flags);
    return;
  }
  const set = await submit(client, hook.wallet, {
    TransactionType: "AccountSet",
    SetFlag: 11,
    Fee: TX_FEE,
  });
  const flags2 = await accountFlags(client, hook.address);
  record(
    "allow weak cron hooks",
    txResult(set) === "tesSUCCESS" && (flags2 & LSF_TSH_COLLECT) !== 0,
    txResult(set) + " flags " + flags2
  );
}

// A leftover BET blocks the next escrow. An Invoke from the pot is a tick:
// the window on a stuck bet has passed, so the hook cancels it.
async function clearStuckBet(client, hook) {
  const before = await readHookState(client, hook.address);
  if (!before) {
    log("table empty");
    return true;
  }
  log("stuck bet", before.HookStateData);
  for (let i = 0; i < 16; i++) {
    const state = await readHookState(client, hook.address);
    if (!state) {
      log("table cleared");
      return true;
    }
    const inv = await submit(client, hook.wallet, {
      TransactionType: "Invoke",
      Fee: TX_FEE,
    });
    log("invoke tick", txResult(inv), hookExecutions(inv).join(" | "));
    if (txResult(inv) !== "tesSUCCESS") return false;
    for (let w = 0; w < 8; w++) {
      await sleep(2000);
      const now = await readHookState(client, hook.address);
      if (!now) {
        log("table cleared");
        return true;
      }
      if (now.HookStateData !== state.HookStateData) {
        log("state moved", now.HookStateData);
        break;
      }
    }
  }
  return !(await readHookState(client, hook.address));
}

async function escrowWindow(client) {
  const led = await client.send({ command: "ledger", ledger_index: "validated" });
  const close = led.ledger?.close_time ?? led.result?.ledger?.close_time;
  if (!Number.isInteger(close)) throw new Error("validated ledger has no close_time");
  return { close, finish: close + 30, cancel: close + 70 };
}

function escrowCreate(destination, drops, tag, times) {
  return {
    TransactionType: "EscrowCreate",
    Destination: destination,
    Amount: String(drops),
    DestinationTag: tag,
    FinishAfter: times.finish,
    CancelAfter: times.cancel,
    Fee: TX_FEE,
  };
}

function rowLedger(row) {
  const tx = row.tx || row.tx_json || {};
  return Number(tx.ledger_index || tx.inLedger || row.ledger_index || 0);
}

async function pollSettlement(client, hookAddress, playerAddress, betDrops, minLedger) {
  const deadline = Date.now() + 150000;
  let face = null;
  let kind = null;
  const strings = [];
  let finishTx = null;
  let cancelTx = null;
  let payTx = null;
  while (Date.now() < deadline) {
    const page = await client.send({
      command: "account_tx",
      account: hookAddress,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 40,
      binary: false,
    });
    for (const row of page.transactions || []) {
      if (minLedger && rowLedger(row) <= minLedger) continue;
      const tx = row.tx || row.tx_json || {};
      const meta = row.meta || row.metadata || {};
      if (meta.TransactionResult && meta.TransactionResult !== "tesSUCCESS") continue;
      for (const text of hookExecutions({ meta })) {
        if (!strings.includes(text)) strings.push(text);
        const match = /^face=([1-6]) (win|loss|refund)$/.exec(text);
        if (match) {
          face = Number(match[1]);
          kind = match[2];
        }
      }
      if (tx.TransactionType === "EscrowFinish" && tx.Account === hookAddress) finishTx = tx;
      if (tx.TransactionType === "EscrowCancel" && tx.Account === hookAddress) cancelTx = tx;
      if (
        tx.TransactionType === "Payment" &&
        tx.Account === hookAddress &&
        tx.Destination === playerAddress &&
        tx.Amount === betDrops
      ) payTx = tx;
    }
    log("poll", strings.slice(-8).join(" | ") || "(no hook strings)", "face", face ?? "-", kind ?? "-");
    if (kind === "win" && cancelTx && payTx) return { face, kind, finishTx, cancelTx, payTx, strings };
    if (kind === "loss" && finishTx) return { face, kind, finishTx, cancelTx, payTx, strings };
    if (kind === "refund" && cancelTx) return { face, kind, finishTx, cancelTx, payTx, strings };
    await sleep(3000);
  }
  return { face, kind, finishTx, cancelTx, payTx, strings, timeout: true };
}

function summary() {
  log("---");
  for (const item of results) log(item.ok ? "PASS" : "FAIL", item.name, item.got);
  const failed = results.filter((item) => !item.ok).length;
  log(failed ? `${failed} failed` : `${results.length} passed`);
  return failed;
}

async function main() {
  if (Buffer.from(NAMESPACE, "hex").length !== 32)
    throw new Error("namespace is not 32 bytes");
  if (Buffer.from(NAMESPACE, "hex").subarray(0, 7).toString() !== "RNGDICE")
    throw new Error("namespace prefix is not RNGDICE");
  if (!fs.existsSync(WASM_PATH))
    throw new Error("missing wasm; run npm run build");
  const wasm = fs.readFileSync(WASM_PATH);
  if (!wasm.includes(Buffer.from("dice")))
    throw new Error("wasm does not import dice");
  const wasmHex = wasm.toString("hex").toUpperCase();
  log("wasm", wasm.length, "bytes");

  const client = new XrplClient(WSS);
  try {
    const info = await client.send({ command: "server_info" });
    const server = info.info || info.result?.info;
    log("connected", server.build_version, "network", server.network_id, WSS);
    if (Number(server.network_id) !== NETWORK_ID)
      throw new Error(`unexpected network id ${server.network_id}`);

    const features = await client.send({ command: "feature" });
    const table = features.features || features.result?.features || {};
    const enabled = (name) => Object.values(table).find((feature) => feature.name === name)?.enabled;
    for (const name of ["RNG", "Hooks", "HooksUpdate2", "Cron", "Escrow"]) {
      log(name, enabled(name) ? "enabled" : "MISSING");
    }
    if (!enabled("RNG")) {
      log("featureRNG is not enabled here. A dice import would be temMALFORMED. No accounts were minted.");
      process.exitCode = 2;
      return;
    }

    const debug = new WebSocket("wss://rng.xahau-dev.net/debugstream/");
    debug.addEventListener("message", (ev) => {
      const text = String(ev.data);
      if (/HookSet|import|guard|dice|Malformed|WASM/i.test(text))
        log("debug", text.slice(0, 700));
    });
    await new Promise((resolve) => {
      debug.addEventListener("open", () => resolve());
      setTimeout(resolve, 2000);
    });

    log("funding hook");
    const hook = await faucetAccount(process.env.RNG_HOOK_SEED);
    log("funding player");
    const player = await faucetAccount(process.env.RNG_PLAYER_SEED);
    await waitForAccount(client, hook.address);
    await waitForAccount(client, player.address);
    log("both accounts are in a validated ledger");

    const playerDrops = await balanceOf(client, player.address);
    const hookDrops = await balanceOf(client, hook.address);
    log("balances hook", hookDrops.toString(), "player", playerDrops.toString());
    if (hookDrops < 25_000_000n && playerDrops > 40_000_000n) {
      const topped = await submit(client, player.wallet, {
        TransactionType: "Payment",
        Destination: hook.address,
        Amount: "15000000",
        Fee: TX_FEE,
      });
      record("fund the pot", txResult(topped) === "tesSUCCESS", txResult(topped));
    }

    const setHook = await submitScalingFee(client, hook.wallet, {
      TransactionType: "SetHook",
      Fee: String((wasmHex.length / 2) * 500 + 2_000_000),
      Hooks: [
        {
          Hook: {
            CreateCode: wasmHex,
            Flags: 5,
            HookApiVersion: 0,
            HookNamespace: NAMESPACE,
            HookOn: HOOK_ON,
          },
        },
      ],
    });
    const installed = txResult(setHook);
    const installMessage = engineMessage(setHook);
    record("install hook", installed === "tesSUCCESS", installed + " " + installMessage);
    if (installed !== "tesSUCCESS") {
      if (/IMPORT_ILLEGAL|does not appear in the hook_api/i.test(installMessage)) {
        log("SetHook rejected the dice import:", installed, installMessage);
        log("The hook was not replaced with ledger_nonce.");
      }
      summary();
      process.exitCode = installed === "temMALFORMED" ? 2 : 1;
      return;
    }

    await enableCollect(client, hook);
    const cleared = await clearStuckBet(client, hook);
    if (!cleared) {
      record("clear previous bet", false, "BET state still present");
      summary();
      process.exitCode = 1;
      return;
    }

    const badGuess = await submitScalingFee(client, player.wallet, escrowCreate(hook.address, 1_000_000, 7, await escrowWindow(client)));
    const badGuessText = hookExecutions(badGuess).join(" | ");
    record(
      "reject face 7",
      txResult(badGuess) === "tecHOOK_REJECTED" && badGuessText.includes("guess 1-6"),
      txResult(badGuess) + " " + badGuessText
    );

    const tooBig = await submitScalingFee(client, player.wallet, escrowCreate(hook.address, 11_000_000, 1, await escrowWindow(client)));
    const tooBigText = hookExecutions(tooBig).join(" | ");
    record(
      "reject 11 XAH",
      txResult(tooBig) === "tecHOOK_REJECTED" && tooBigText.includes("max 10 xah"),
      txResult(tooBig) + " " + tooBigText
    );

    const times = await escrowWindow(client);
    log("escrow window close", times.close, "finish", times.finish, "cancel", times.cancel);
    const bet = await submitScalingFee(client, player.wallet, escrowCreate(hook.address, 1_000_000, 1, times));
    const betText = hookExecutions(bet).join(" | ");
    const locked = record(
      "lock 1 XAH on face 1",
      txResult(bet) === "tesSUCCESS" && betText.includes("locked"),
      txResult(bet) + " " + betText + " seq " + bet.sequence
    );

    if (locked) {
      const busy = await submitScalingFee(client, player.wallet, escrowCreate(hook.address, 1_000_000, 2, await escrowWindow(client)));
      const busyText = hookExecutions(busy).join(" | ");
      record(
        "second bet is busy",
        txResult(busy) === "tecHOOK_REJECTED" && busyText.includes("table busy"),
        txResult(busy) + " " + busyText
      );
    }

    if (!locked) {
      summary();
      process.exitCode = 1;
      return;
    }

    const betLedger = Number(bet.result?.ledger_index || bet.result?.inLedger || 0);
    log("bet ledger", betLedger);
    const settled = await pollSettlement(client, hook.address, player.address, "1000000", betLedger);
    log("settled", JSON.stringify({
      face: settled.face,
      kind: settled.kind,
      timeout: !!settled.timeout,
      strings: settled.strings,
    }));

    let played = false;
    if (settled.kind === "win") {
      played = record(
        "win pays the stake back and the prize",
        settled.face === 1 && !!settled.cancelTx && !!settled.payTx && !settled.finishTx,
        `face ${settled.face}`
      );
    } else if (settled.kind === "loss") {
      played = record(
        "loss finishes the escrow into the pot",
        settled.face !== 1 && !!settled.finishTx && !settled.payTx,
        `face ${settled.face}`
      );
    } else if (settled.kind === "refund") {
      record(
        "roll settled as a refund",
        false,
        settled.strings.filter((text) => text === "entropy" || text.startsWith("face=")).join(" | ") || "refund"
      );
    } else {
      record("roll produced a face", false, settled.timeout ? "timed out " + settled.strings.join(" | ") : "no face");
    }

    if (played) {
      const published = {
        account: hook.address,
        networkId: NETWORK_ID,
        wss: WSS,
        rpc: "https://rpc.rng.xahau-dev.net",
        explorer: "https://explorer.rng.xahau-dev.net",
        namespace: NAMESPACE,
      };
      fs.writeFileSync(HOOK_JSON, JSON.stringify(published, null, 2) + "\n");
      log("wrote", HOOK_JSON);
      log("play account", hook.address);
    }

    const failed = summary();
    if (failed) process.exitCode = 1;
  } finally {
    client.close();
  }
}

main().catch((error) => {
  log("ERROR", error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});
