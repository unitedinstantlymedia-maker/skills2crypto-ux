import "@stdlib/deploy";
import "@stdlib/ownable";

// Skills2CryptoEscrow V2 — TON player-pays-gas escrow.
//
// Architecture (Task #16 rewrite):
//   1. Each player sends a Deposit message directly via TonConnect with
//      msg.value >= stake + ~0.05 TON for gas. First deposit creates the
//      match in PENDING status; second flips it to ACTIVE.
//   2. After the game ends off-chain the server (oracle) signs a 32-byte
//      hash of (matchId, winner, reason) with its Ed25519 key.
//   3. The winner (Normal) or either player (Draw/Disconnect) sends a
//      Settle message containing that signature; the contract verifies it
//      against the stored oracle pubkey, then disperses funds. The caller
//      pays gas — the oracle never sends a transaction.
//
// Payouts:
//   - Normal:     winner gets 2*stake - 3% platform fee
//   - Draw:       each gets stake - 1.5%
//   - Disconnect: each gets full stake (no fee — neither player completed)

message Deposit {
    matchId: Int as uint256;
    player1: Address;
    player2: Address;
    stake: Int as coins;
}

message Settle {
    matchId: Int as uint256;
    winner: Address;
    reason: Int as uint8;
    signature: Slice;
}

message RefundNoShow { matchId: Int as uint256; }

message SetOraclePubkey { newPubkey: Int as uint256; }
message SetPlatformWallet { newWallet: Address; }
message SetDepositTimeout { seconds: Int as uint32; }

struct Match {
    matchId: Int as uint256;
    player1: Address;
    player2: Address;
    stake: Int as coins;
    p1Funded: Bool;
    p2Funded: Bool;
    firstDepositAt: Int as uint32;
    status: Int as uint8;
}

const STATUS_NONE: Int = 0;
const STATUS_PENDING: Int = 1;
const STATUS_ACTIVE: Int = 2;
const STATUS_SETTLED: Int = 3;

const REASON_NORMAL: Int = 0;
const REASON_DRAW: Int = 1;
const REASON_DISCONNECT: Int = 2;

const PLATFORM_FEE_BPS: Int = 300; // 3.00%
const FEE_DENOMINATOR: Int = 10000;
const MIN_GAS_BUFFER: Int = ton("0.05");

contract Skills2CryptoEscrowTON with Deployable, Ownable {
    owner: Address;
    oraclePubkey: Int as uint256;
    platformWallet: Address;
    depositTimeoutSeconds: Int as uint32;
    matches: map<Int, Match>;

    init(oraclePubkey: Int, platformWallet: Address, depositTimeoutSeconds: Int) {
        self.owner = sender();
        self.oraclePubkey = oraclePubkey;
        self.platformWallet = platformWallet;
        self.depositTimeoutSeconds = depositTimeoutSeconds;
        self.matches = emptyMap();
    }

    receive(msg: Deposit) {
        let player: Address = sender();
        require(msg.player1 != msg.player2, "Same player");
        require(msg.stake > 0, "Zero stake");
        require(player == msg.player1 || player == msg.player2, "Not a player");
        require(context().value >= msg.stake + MIN_GAS_BUFFER, "Insufficient TON");

        let existing: Match? = self.matches.get(msg.matchId);
        if (existing == null) {
            self.matches.set(msg.matchId, Match{
                matchId: msg.matchId,
                player1: msg.player1,
                player2: msg.player2,
                stake: msg.stake,
                p1Funded: player == msg.player1,
                p2Funded: player == msg.player2,
                firstDepositAt: now(),
                status: STATUS_PENDING
            });
        } else {
            let m: Match = existing!!;
            require(m.status == STATUS_PENDING, "Match not pending");
            require(m.player1 == msg.player1 && m.player2 == msg.player2, "Player mismatch");
            require(m.stake == msg.stake, "Stake mismatch");

            if (player == m.player1) {
                require(!m.p1Funded, "P1 already funded");
                m.p1Funded = true;
            } else {
                require(!m.p2Funded, "P2 already funded");
                m.p2Funded = true;
            }

            if (m.p1Funded && m.p2Funded) {
                m.status = STATUS_ACTIVE;
            }
            self.matches.set(msg.matchId, m);
        }
    }

    receive(msg: Settle) {
        require(msg.reason >= REASON_NORMAL && msg.reason <= REASON_DISCONNECT, "Invalid reason");

        let existing: Match? = self.matches.get(msg.matchId);
        require(existing != null, "Match not found");
        let m: Match = existing!!;
        require(m.status == STATUS_ACTIVE, "Not active");

        // Build hash of (matchId, winner, reason) and verify oracle signature.
        // The off-chain signer uses the identical cell layout below.
        let payload: Cell = beginCell()
            .storeUint(msg.matchId, 256)
            .storeAddress(msg.winner)
            .storeUint(msg.reason, 8)
            .endCell();
        require(checkSignature(payload.hash(), msg.signature, self.oraclePubkey), "Invalid oracle sig");

        let player: Address = sender();
        if (msg.reason == REASON_NORMAL) {
            require(msg.winner == m.player1 || msg.winner == m.player2, "Invalid winner");
            require(player == msg.winner, "Only winner can claim");
        } else {
            require(player == m.player1 || player == m.player2, "Only player");
        }

        m.status = STATUS_SETTLED;
        self.matches.set(msg.matchId, m);

        let totalStake: Int = m.stake * 2;

        if (msg.reason == REASON_NORMAL) {
            let platformFee: Int = (totalStake * PLATFORM_FEE_BPS) / FEE_DENOMINATOR;
            let payout: Int = totalStake - platformFee;
            send(SendParameters{
                to: msg.winner,
                value: payout,
                mode: SendPayGasSeparately,
                body: "Win payout".asComment()
            });
            send(SendParameters{
                to: self.platformWallet,
                value: platformFee,
                mode: SendPayGasSeparately,
                body: "Platform fee".asComment()
            });
        } else if (msg.reason == REASON_DRAW) {
            let platformFee: Int = (totalStake * PLATFORM_FEE_BPS) / FEE_DENOMINATOR;
            let halfFee: Int = platformFee / 2;
            let refundPerPlayer: Int = m.stake - halfFee;
            send(SendParameters{
                to: m.player1,
                value: refundPerPlayer,
                mode: SendPayGasSeparately,
                body: "Draw refund".asComment()
            });
            send(SendParameters{
                to: m.player2,
                value: refundPerPlayer,
                mode: SendPayGasSeparately,
                body: "Draw refund".asComment()
            });
            send(SendParameters{
                to: self.platformWallet,
                value: platformFee,
                mode: SendPayGasSeparately,
                body: "Platform fee".asComment()
            });
        } else {
            // Disconnect: full stake refund to each player, no fee.
            send(SendParameters{
                to: m.player1,
                value: m.stake,
                mode: SendPayGasSeparately,
                body: "Disconnect refund".asComment()
            });
            send(SendParameters{
                to: m.player2,
                value: m.stake,
                mode: SendPayGasSeparately,
                body: "Disconnect refund".asComment()
            });
        }
    }

    receive(msg: RefundNoShow) {
        let existing: Match? = self.matches.get(msg.matchId);
        require(existing != null, "Match not found");
        let m: Match = existing!!;
        require(m.status == STATUS_PENDING, "Not pending");
        require(now() > m.firstDepositAt + self.depositTimeoutSeconds, "Not expired");

        let player: Address = sender();
        if (m.p1Funded && !m.p2Funded) {
            require(player == m.player1, "Only depositor");
            m.status = STATUS_SETTLED;
            self.matches.set(msg.matchId, m);
            send(SendParameters{
                to: m.player1,
                value: m.stake,
                mode: SendPayGasSeparately,
                body: "No-show refund".asComment()
            });
        } else if (m.p2Funded && !m.p1Funded) {
            require(player == m.player2, "Only depositor");
            m.status = STATUS_SETTLED;
            self.matches.set(msg.matchId, m);
            send(SendParameters{
                to: m.player2,
                value: m.stake,
                mode: SendPayGasSeparately,
                body: "No-show refund".asComment()
            });
        } else {
            require(false, "Invalid funding state");
        }
    }

    receive(msg: SetOraclePubkey) {
        self.requireOwner();
        self.oraclePubkey = msg.newPubkey;
    }

    receive(msg: SetPlatformWallet) {
        self.requireOwner();
        self.platformWallet = msg.newWallet;
    }

    receive(msg: SetDepositTimeout) {
        self.requireOwner();
        self.depositTimeoutSeconds = msg.seconds;
    }

    get fun getMatch(matchId: Int): Match? {
        return self.matches.get(matchId);
    }

    get fun getOraclePubkey(): Int {
        return self.oraclePubkey;
    }

    get fun getPlatformWallet(): Address {
        return self.platformWallet;
    }

    get fun getDepositTimeoutSeconds(): Int {
        return self.depositTimeoutSeconds;
    }
}
