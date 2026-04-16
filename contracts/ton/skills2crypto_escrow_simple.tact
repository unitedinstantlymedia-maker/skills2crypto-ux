import "@stdlib/deploy";
import "@stdlib/ownable";

// PrepareMatch (oracle-only): registers a new match before deposits arrive.
message PrepareMatch {
    matchId: Int as uint256;
    player1: Address;
    player2: Address;
    stake: Int as coins;
}

// PlayerDeposit (player-sent): credits this player's stake to a prepared match.
// The player attaches `stake + gasShare` TON as the message value.
message PlayerDeposit {
    matchId: Int as uint256;
}

// Settle (oracle-only): pays out the winner / refunds players / forwards the
// platform fee. reason: 0 = normal win, 1 = draw, 2 = disconnect.
message Settle {
    matchId: Int as uint256;
    winner: Address;
    reason: Int as uint8;
}

message UpdateGasReserve {
    perPlayer: Int as coins;
}
message SetOracle { newOracle: Address; }
message SetPlatformWallet { newWallet: Address; }
message CancelMatch { matchId: Int as uint256; }

struct Match {
    matchId: Int as uint256;
    player1: Address;
    player2: Address;
    stake: Int as coins;
    gasReservePerPlayer: Int as coins;
    p1Funded: Bool;
    p2Funded: Bool;
    status: Int as uint8;
}

const STATUS_NONE: Int = 0;
const STATUS_PENDING: Int = 1;
const STATUS_ACTIVE: Int = 2;
const STATUS_SETTLED: Int = 3;
const STATUS_CANCELLED: Int = 4;

const REASON_NORMAL: Int = 0;
const REASON_DRAW: Int = 1;
const REASON_DISCONNECT: Int = 2;

const PLATFORM_FEE_BPS: Int = 300; // 3.00%
const FEE_DENOMINATOR: Int = 10000;

contract Skills2CryptoEscrowTON with Deployable, Ownable {
    owner: Address;
    oracle: Address;
    platformWallet: Address;
    gasReservePerPlayer: Int as coins;
    matches: map<Int, Match>;

    init(oracle: Address, platformWallet: Address, gasReservePerPlayer: Int) {
        self.owner = sender();
        self.oracle = oracle;
        self.platformWallet = platformWallet;
        self.gasReservePerPlayer = gasReservePerPlayer;
        self.matches = emptyMap();
    }

    receive(msg: PrepareMatch) {
        require(sender() == self.oracle, "Only oracle");
        require(msg.player1 != msg.player2, "Same player");
        require(msg.stake > 0, "Zero stake");
        let existing: Match? = self.matches.get(msg.matchId);
        require(existing == null, "Match exists");

        self.matches.set(msg.matchId, Match{
            matchId: msg.matchId,
            player1: msg.player1,
            player2: msg.player2,
            stake: msg.stake,
            gasReservePerPlayer: self.gasReservePerPlayer,
            p1Funded: false,
            p2Funded: false,
            status: STATUS_PENDING
        });
    }

    receive(msg: PlayerDeposit) {
        let player: Address = sender();
        let existing: Match? = self.matches.get(msg.matchId);
        require(existing != null, "Match not prepared");
        let m: Match = existing!!;
        require(m.status == STATUS_PENDING, "Match not pending");

        let required: Int = m.stake + m.gasReservePerPlayer;
        require(context().value >= required, "Insufficient TON sent");

        if (player == m.player1) {
            require(!m.p1Funded, "P1 already funded");
            m.p1Funded = true;
        } else if (player == m.player2) {
            require(!m.p2Funded, "P2 already funded");
            m.p2Funded = true;
        } else {
            require(false, "Not a participant");
        }

        if (m.p1Funded && m.p2Funded) {
            m.status = STATUS_ACTIVE;
        }
        self.matches.set(msg.matchId, m);

        // Refund any excess back to the player.
        let excess: Int = context().value - required;
        if (excess > ton("0.01")) {
            send(SendParameters{
                to: player,
                value: excess,
                mode: SendPayGasSeparately,
                body: "Excess deposit refund".asComment()
            });
        }
    }

    receive(msg: Settle) {
        require(sender() == self.oracle, "Only oracle");
        require(msg.reason >= REASON_NORMAL && msg.reason <= REASON_DISCONNECT, "Invalid reason");

        let existing: Match? = self.matches.get(msg.matchId);
        require(existing != null, "Match not found");
        let m: Match = existing!!;
        require(m.status == STATUS_ACTIVE, "Not active");

        m.status = STATUS_SETTLED;
        self.matches.set(msg.matchId, m);

        let totalStake: Int = m.stake * 2;
        let totalGasReserve: Int = m.gasReservePerPlayer * 2;
        let halfGas: Int = totalGasReserve / 2;
        let otherHalfGas: Int = totalGasReserve - halfGas;

        if (msg.reason == REASON_NORMAL) {
            require(msg.winner == m.player1 || msg.winner == m.player2, "Invalid winner");
            let platformFee: Int = (totalStake * PLATFORM_FEE_BPS) / FEE_DENOMINATOR;
            let payout: Int = totalStake - platformFee;
            let loser: Address = msg.winner == m.player1 ? m.player2 : m.player1;

            send(SendParameters{
                to: msg.winner,
                value: payout + halfGas,
                mode: SendPayGasSeparately,
                body: "Win payout".asComment()
            });
            send(SendParameters{
                to: loser,
                value: otherHalfGas,
                mode: SendPayGasSeparately,
                body: "Gas reserve return".asComment()
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
                value: refundPerPlayer + halfGas,
                mode: SendPayGasSeparately,
                body: "Draw refund".asComment()
            });
            send(SendParameters{
                to: m.player2,
                value: refundPerPlayer + otherHalfGas,
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
            // REASON_DISCONNECT — full stake refund per player
            send(SendParameters{
                to: m.player1,
                value: m.stake + halfGas,
                mode: SendPayGasSeparately,
                body: "Disconnect refund".asComment()
            });
            send(SendParameters{
                to: m.player2,
                value: m.stake + otherHalfGas,
                mode: SendPayGasSeparately,
                body: "Disconnect refund".asComment()
            });
        }
    }

    // CancelMatch lets the oracle reclaim partial deposits if only one player
    // funded and the other timed out. Refunds whoever paid; cleans up state.
    receive(msg: CancelMatch) {
        require(sender() == self.oracle, "Only oracle");
        let existing: Match? = self.matches.get(msg.matchId);
        require(existing != null, "Match not found");
        let m: Match = existing!!;
        require(m.status == STATUS_PENDING, "Not pending");

        m.status = STATUS_CANCELLED;
        self.matches.set(msg.matchId, m);

        let refund: Int = m.stake + m.gasReservePerPlayer;
        if (m.p1Funded) {
            send(SendParameters{
                to: m.player1,
                value: refund,
                mode: SendPayGasSeparately,
                body: "Match cancelled refund".asComment()
            });
        }
        if (m.p2Funded) {
            send(SendParameters{
                to: m.player2,
                value: refund,
                mode: SendPayGasSeparately,
                body: "Match cancelled refund".asComment()
            });
        }
    }

    receive(msg: UpdateGasReserve) {
        require(sender() == self.oracle || sender() == self.owner, "Only oracle/owner");
        require(msg.perPlayer > 0, "Zero gas reserve");
        self.gasReservePerPlayer = msg.perPlayer;
    }

    receive(msg: SetOracle) {
        self.requireOwner();
        self.oracle = msg.newOracle;
    }

    receive(msg: SetPlatformWallet) {
        self.requireOwner();
        self.platformWallet = msg.newWallet;
    }

    get fun getMatch(matchId: Int): Match? {
        return self.matches.get(matchId);
    }

    get fun getOracle(): Address {
        return self.oracle;
    }

    get fun getPlatformWallet(): Address {
        return self.platformWallet;
    }

    get fun getGasReservePerPlayer(): Int {
        return self.gasReservePerPlayer;
    }
}
