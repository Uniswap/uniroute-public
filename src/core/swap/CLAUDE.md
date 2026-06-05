# `core/swap/`

Universal Router input encoders for UniRoute's quote response. Files:

- **`SwapOptionsFactory.ts`** — legacy `swapCallParameters` options builder,
  consumed by `lib/methodParameters.ts` to populate
  `QuoteResponse.methodParameters`. In swapsteps mode it suppresses
  `fee`/`flatFee` so the fallback calldata stays fee-neutral.

- **`SwapStepsFactory.ts`** — pure `QuoteSplit → SwapStep[]` builder. Feeds
  both `QuoteResponse.swapSteps` (gated on `x-universal-router-swapsteps`) and
  the simulation calldata.

- **`SwapStepsBuilder.ts`** — turns those `SwapStep[]` into `encodeSwaps`
  calldata for *simulation* (`buildSwapStepsMethodParameters`) plus the
  fee-neutral `SwapSpecification` (`buildSwapSpecification`).

`QuoteResponse.swapSteps` is `repeated google.protobuf.Struct` — `UniRouteBL`
emits the factory's `SwapStep[]` verbatim (`Struct.fromJsonString(JSON.stringify(step))`),
so the JSON keeps the SDK's `{type, ...}` / v4 `{action, ...}` discriminated-union
shape that `SwapRouter.encodeSwaps` and Trading's Joi schema expect (rather than a
proto `oneof` wrapper).

Types come straight from `@uniswap/universal-router-sdk` (≥ 5.4.0 exports
`SwapStep`/`V4Action`/`PoolKey`/`PathKey`/`ROUTER_AS_RECIPIENT`); UniRoute keeps
only the producer sentinels (`SENTINEL_AMOUNT`, `V4_OPEN_DELTA`) in
`SwapStepsFactory.ts`.

Both paths coexist during the rollout; consumers pick based on the header.

## SwapStepsFactory invariants

These are non-negotiable and locked by tests in
`SwapStepsFactory.test.ts`:

- **All recipients are `ROUTER_AS_RECIPIENT` (`0x0...02`).** The SDK's
  `SwapRouter.encodeSwaps` adds the final user transfer separately via
  `SwapSpecification`; per-step recipients are router-local.

- **Fee-neutral.** Never emit `PAY_PORTION`, `TAKE_PORTION`, or any
  fee-adjusted amount. Trading owns fee math through `SwapSpecification`'s
  `fee`/`flatFee`. `populateQuoteResponse` and `SwapOptionsFactory` suppress
  the portion/fee fields in swapsteps mode; this factory stays pure.

- **No `chainId` parameter.** `wrappedAddress` on `CurrencyInfo` already
  encodes the chain's WETH; pool currencies carry their own context. If a
  future caller needs chain-specific behavior, add the param then — don't
  thread it through preemptively.

## V4 grouped-action shape

V4 segments emit **one `V4_SWAP` step per quote** (not one per pool, not
one consolidated step across the whole `QuoteSplit`). The action ordering
follows Guidestar's payload convention:

```text
[ SETTLE   { currency: input, amount: allocatedAmountIn },
  SWAP_*   ( SWAP_EXACT_IN_SINGLE for 1 pool, SWAP_EXACT_IN for multi-hop ),
  TAKE     { currency: output, recipient: ROUTER_AS_RECIPIENT, amount: 0 } ]
```

Notable details:

- Use `SETTLE` (with explicit `amount`) not `SETTLE_ALL`. Use `TAKE` (with
  `amount: 0`) not `TAKE_ALL`. Both forms are SDK-valid; we match Guidestar
  for consistency across the two router producers.
- `hookData: ''` (empty string), not `'0x'` — matches Guidestar and what the
  response/Trading consume. The SDK encoder rejects `''` (ethers `arrayify`),
  so `SwapStepsBuilder` normalizes `'' → '0x'` only for the `encodeSwaps` call;
  the emitted `swapSteps` keep `''`.
- `poolKey.currency0 < currency1` is enforced by UniRoute's `Address.sorted`
  in pool construction; `zeroForOne` is derived from whether `tokenIn`
  matches `pool.token0`.
- V4 native pools use `0x0000…0` as a currency directly. No `WRAP_ETH` is
  needed for V4 native segments; the V4 PoolManager handles native ETH
  natively.

## Native input/output handling

`WRAP_ETH` and `UNWRAP_WETH` are emitted at the **outer** level (before/after
all per-quote steps), not per-segment. Logic:

- `WRAP_ETH` amount = sum of allocated `amountIn` for quotes whose first
  pool routes through WETH (V2 / V3 / V4 with WETH currency). V4 native
  pools (currency = `0x0`) are skipped — their portion stays as native and
  feeds the V4 `SETTLE` directly.
- `UNWRAP_WETH` is emitted whenever any quote ends in WETH and the user's
  `tokenOut` is native.

The partial-wrap test in `SwapStepsFactory.test.ts` locks in the mixed
V3+V4 native split: only the V3 portion gets wrapped.

## encodeSwaps simulation (SwapStepsBuilder)

In swapsteps mode `simulateAndPopulateBestQuote` simulates the calldata Trading
will actually submit: `buildSwapSteps` → `buildSwapSpecification` (fee-neutral)
→ `SwapRouter.encodeSwaps`. On factory/encoder error (e.g. MIXED EXACT_OUT) it
falls back to the legacy `buildSwapMethodParameters` so the request still yields
a simulated quote; the response `swapSteps` are built independently in
`populateQuoteResponse` and stay authoritative regardless.

`SwapSpecification` is fee-neutral (`fee: undefined`) — Trading owns fee math.
`routing.amount` is the exact side, `routing.quote` the slippage side;
`encodeSwaps` derives the native msg.value from these + `slippageTolerance`.
`SwapStepsBuilder.test.ts` round-trips the factory output through the real SDK
encoder for V2/V3/V4/MIXED — the end-to-end validation the factory alone lacks.

Types are imported from the SDK (not mirrored). Trading keeps the Joi schemas as
the validating consumer; UniRoute is the producer and carries types only.

## Chained-segment amount sentinels (MIXED routes)

When a MIXED route's path crosses protocols, the leaf segment is
user-funded but downstream segments must consume currency that the prior
segment left in router custody. Each amount field uses a different
"consume what's there" sentinel:

| Field | Sentinel | Constant |
|---|---|---|
| V2 / V3 chained `amountIn` | `2**255` | `SENTINEL_AMOUNT` (UR `CONTRACT_BALANCE`) |
| V4 chained `SETTLE.amount` | `2**255` | `SENTINEL_AMOUNT` (matches Guidestar) |
| V4 chained `SWAP.amountIn` | `0` | `V4_OPEN_DELTA` (V4-specific) |

The V4 SWAP needs a distinct sentinel because its `amountIn` field is
`int128`. `SENTINEL_AMOUNT = 2^255` would overflow. V4 treats `amountIn=0`
as "use the open delta" (whatever the prior `SETTLE` deposited).

Guidestar emits *real* intermediate amounts on V4 `SWAP.amountIn` (computed
from upstream routing math). UniRoute uses `V4_OPEN_DELTA` instead because
`QuoteSplit` doesn't track per-pool intermediate amounts. Both approaches
are valid; UniRoute's is simpler at the cost of giving the router slightly
less information.

## Not yet covered

- **FOT / fee-on-transfer routes**: factory accepts them but hasn't been
  validated against FOT-specific behavior.

## Reference docs

- Trading-side Joi schemas + discriminators: `services/trading/src/models/swapSteps.ts`.
- Guidestar payload conventions: derived empirically from a captured
  Guidestar `swap_steps` response. The Guidestar producer is the source of
  truth for the V4 grouped-action shape; mirror its conventions when in
  doubt.
