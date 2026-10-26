# Disposable Shasta zero-TRX proof

This opt-in CLI is isolated from the application, its startup and normal tests.
It reads only `SHASTA_TEST_SPONSOR_PRIVATE_KEY`, a dedicated test-only credential
entered through the workspace's secure secret form. Never use a production or
real-money wallet key. The RPC is fixed to Shasta, and the chain ID is checked
before preparing wallets or running on-chain operations.
**Never send mainnet funds to any generated test address.**

```sh
node --test tests/tron-shasta/support.test.cjs
node tests/tron-shasta/proof.cjs --compile
node tests/tron-shasta/proof.cjs --prepare
node tests/tron-shasta/proof.cjs --status tests/tron-shasta/sessions/REPLACE
node tests/tron-shasta/proof.cjs --run tests/tron-shasta/sessions/REPLACE
```

The original setup-only session can be continued once with `--resume-setup DIR`.
This mode validates the exact ten-transaction setup journal, rechecks all ten
solidified receipts and never repeats activation/staking/delegation setup.
An exclusive continuation marker prevents blindly retrying an interrupted
continuation. Contract deployment and test-token minting may spend sponsor test
TRX as setup costs; all measured approvals/deposits/settlements still require
full resource coverage and zero TRX burn. Player resource top-ups use live
weights, the transaction Energy estimate plus 25%, and an additional 2% capacity
margin. Player Energy delegation is reclaimed after approval for reuse; used
Energy debt returns to the sponsor and is not magically replenished.
The narrower `--resume-token DIR` recovery accepts exactly those ten setup
transactions plus the first token deployment, reconciles that deployment and
reuses its contract rather than deploying another token. Each continuation
has its own exclusive marker; neither is a general automatic retry command.
Approval transactions are rebuilt and signed after provisioning has solidified
so resource-delivery delays cannot expire an already-built transaction.

Use the public session directory printed by `--prepare`. It contains only
public addresses, a run ID, status and transaction evidence. No private-key
file is ever written. Role keys are derived in memory using HMAC-SHA256 with
the dedicated test key, the public run ID and role-specific domain separation.
The same secret/run ID reconstructs the same wallets after filesystem
replacement. The sponsor remains controlled by the owner's test-only key.
Public status checks do not need the secret.

Preserve the public session manifest and transaction journal in checkpoints
alongside the harness. A durable signer does not make a missing transaction
journal safe to ignore: recover public on-chain history before resuming.
Never automatically restart a partially executed session.

The initial prototype used `/tmp` private wallets. That directory disappeared
between turns after its sponsor was funded. It is not a supported storage
scheme; do not send any additional tokens to that old address.

Only the sponsor needs test TRX. **The original 2,000-test-TRX budget is not
sufficient for this runner's resource allocations at the observed Shasta
staking ratios. Do not request funding or run another session using that
assumption.** In the first execution, 200 TRX of delegated stake provided only
2,810 Energy per player; 20 TRX provided only 1 staked Bandwidth per player.
That execution was stopped before contract deployment. Read its public
reconciliation record and re-size resource provisioning before continuing.
The official test-token source is linked from
https://developers.tron.network/docs/getting-testnet-tokens-on-tron.
Never fund players with TRX. Their accounts are activated using CreateAccount,
then receive delegated Energy and Bandwidth. Test-token minting does not
transfer TRX.

The run deploys a six-decimal **mock token** and a **test escrow**, mints test
tokens, executes two MAX approvals, three paired deposits and normal/draw/
disconnect settlements at 5 tokens per player. Typed-data message shapes
follow the existing escrow. The fixture has 3% base commission and a direct 1%
resource fee without swaps; it is not the final production replacement contract.

The installed Solidity compiler is used with EVM target `paris`, importing the
existing TRON-scoped OpenZeppelin dependencies rather than root dependencies
which require Cancun instructions. No dependency versions are changed.

Every contract write requires estimated Energy plus 25% and conservatively
budgeted Bandwidth. Measured operations reject receipt-level fee burns and
any caller TRX-balance change. Player balances must remain exactly zero.
Token accounting and match state are checked for all settlement types.
Test staking allocations are not rental quantities or market-cost estimates;
insufficient resources stop execution before broadcast.

Transaction IDs are journalled **before broadcast**, and included transactions
must also acquire a SolidityNode receipt. Public evidence is in `results.json`
in the public session directory. Started runs cannot be blindly replayed after
failure: reconcile all journalled IDs first.

## Evidence boundaries

- Mock-token receipts do **not** establish mainnet USDT costs.
- The test escrow is **not** byte-for-byte the future production escrow.
- Sponsor delegation does **not** verify TronZap service delivery or Shasta support.
- CLI signing does **not** demonstrate TronLink/mobile wallet behavior.
- This run does **not** prove provider USDT replenishment or economic sustainability.
- Initial suite covers the successful lifecycle; dedicated replay/denial, resource
  exhaustion and delayed-signature on-chain scenarios remain separate proof steps.
- No production code, schema, configuration, workflow or mainnet change is made.
