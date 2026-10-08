# RNG dice

A hook and a browser page. The player escrows a native bet of at most 10 XAH.
The hook records that escrow, and only then draws a face. A loss finishes the
escrow into the pot. A win cancels it, which returns the stake, and the pot
pays the same amount.

The roll is `dice(6)` from [featureRNG](https://github.com/Xahau/xahaud/pull/869)
(`xahaud` PR 869, amendment name `RNG`). `dice` returns `0..5`. The hook stores
`1..6`. It does not call `dice()` while accepting the escrow. A draw in that
transaction could be vetoed by a later strong hook. The cron that rolls is a
later transaction.

## Network

The root devnet (`wss://xahau-dev.net`) does not have the `RNG` amendment.
The dice import is whitelisted only while that amendment is on, so this demo
uses the RNG devnet. Both networks use network id `21339`.

| | |
|---|---|
| WebSocket | `wss://rng.xahau-dev.net` |
| RPC | `https://rpc.rng.xahau-dev.net` |
| Explorer | `https://explorer.rng.xahau-dev.net` |
| Faucet | `POST https://faucet.rng.xahau-dev.net/accounts` with `{}` |
| Debug stream | `wss://rng.xahau-dev.net/debugstream/` |

A signature made for the root devnet is for a different ledger that happens
to share the id.

`hook.json` is written by the devnet test after a bet settles. It holds
the hook account, the network, and the namespace. It does not hold a seed.

## Play

The bootloader copy is
[https://pwa.pwapp.xahau-dev.net/rwFYk1YPuzTfJ6wMYseVXedxys9Bf9Wqja](https://pwa.pwapp.xahau-dev.net/rwFYk1YPuzTfJ6wMYseVXedxys9Bf9Wqja).
That page is stored on the PWA bootloader, `wss://pwapp.xahau-dev.net`. The
bet settles on the RNG devnet, `wss://rng.xahau-dev.net`.

```bash
npm install
npm run build
npx serve .
```

Open the served `index.html`, or the bootloader URL above. Pick a face, set a
bet from 0.1 to 10 XAH, and press **Place bet**. The page signs an
`EscrowCreate` in the browser and submits the signed blob on the RNG socket.
The public node will not accept a `secret`. The explorer command box returns
`notSupported` for that.

The demo player is `raFaXQGWPdGPRxsQGKTGzWcksqhA63wxH4`. The signing key stays
in the page so the button can sign. It is not printed on screen. The pot seed
and the bootloader seed are not in the page.

The bet uses the validated ledger time at the moment you press the button.
Finish is 20 seconds later and cancel is 20 seconds after that. A loss can
finish once that first 20 seconds has passed. A win pays after the cancel
time, so it waits 40 seconds. The hook rejects a shorter gap. After the bet
is accepted the status says escrow created and counts down to the cancel
time. The face result stays on that line. The hook's empty-table `idle` tick
does not replace it. The wallet line is the player balance and turns green
when it rises and red when it falls.
Signing for a different devnet does not reach this hook.

The local page draws the die with CSS pips. Place bet spins that die until a
validated hook string matches `face=N win`, `face=N loss`, or `face=N refund`.
The boot document is 4095 bytes. A CSS pip grid does not fit there, so the
published page spins the pip characters instead.

## What the hook does

Install with Flags `5` (`hsfOVERRIDE | hsfCOLLECT`) and `HookOn` all zeros, so
cron runs and SetHook does not. The ledger stores Flags `4`. Also set the
account flag `asfTshCollect` (`AccountSet`, `SetFlag` `11`). A cron names its
owner as a weak stakeholder, and the engine skips that hook unless the account
has `lsfTshCollect`. The hook flag alone does not roll the dice. Namespace is
`RNGDICE` padded to 32 bytes:

`524E474449434500000000000000000000000000000000000000000000000000`

One bet is stored under the key `BET`.

1. **EscrowCreate** to this account, with `DestinationTag` `1..6` and a native
   amount of at most 10,000,000 drops. `FinishAfter` must be 12 to 180 seconds
   ahead of the parent close, and `CancelAfter` must be 20 to 90 seconds after
   `FinishAfter`. The page uses 20 and 20. The hook checks that the pot can
   cover an even-money win, saves the bet, and emits one `CronSet`. It does
   not roll.
2. The cron calls `dice(6)`. `TOO_LITTLE_ENTROPY` (`-46`) retries. After 12
   failures past `CancelAfter`, the hook cancels and pays no prize.
3. **Loss**, while `FinishAfter < close time <= CancelAfter`: emit
   `EscrowFinish`. The stake is paid to this account.
4. **Win**, after `CancelAfter`: emit `EscrowCancel`, then on that callback
   emit a `Payment` of the same number of drops. The win therefore waits out
   the whole window. A loss can settle earlier.
5. A missed loss window cancels and pays no prize.

`fix1571` is what splits those windows. Finish is legal only until
`CancelAfter`. Cancel is legal only after it.

A hook on the bettor's account can reject `EscrowFinish` until `CancelAfter`,
then cancel, and the pot pays nothing. Test accounts have no such hook.

If the prize payment fails, the next cron retries it. The escrow is not
finished a second time.

## Build and test

```bash
npm run build
npm run test:page
npm test
```

`npm run build` compiles `rng_dice.c` (exports `hook` and `cbak`, imports `dice`).
`hookapi.h` comes from a sibling `xahaud` checkout (`../xahaud/hook`).
The page test opens the HTML in headless Chrome at desktop and mobile widths.

`test-devnet.mjs` faucets two accounts on the RNG devnet, installs the hook,
sets `asfTshCollect`, rejects a bad guess and a bet above 10 XAH, locks one
1 XAH escrow, and waits for the cron to roll and settle. Set `RNG_HOOK_SEED`
and `RNG_PLAYER_SEED` to reuse accounts instead of minting. Seeds are printed
to stdout and are not written into this repo.
