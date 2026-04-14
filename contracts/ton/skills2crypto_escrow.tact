import "@stdlib/deploy";
import "@stdlib/ownable";

message RegisterSession {
    sessionAddr: Address;
    maxStake: Int as coins;
    expiry: Int as uint64;
}

message RevokeSession {}

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
}

message UpdateGasPrice {
    gasPriceInTon: Int as coins;
}

message SetOracle {
    newOracle: Address;
}

message SetPlatformWallet {
    newWallet: Address;
}

struct SessionKey {
    player: Address;
    sessionAddr: Address;
    maxStake: Int as coins;
    expiry: Int as uint64;
    revoked: Bool;
    active: Bool;
}

struct MatchData {
    matchId: Int as uint256;
    player1: Address;
    player2: Address;
    stake: Int as coins;
    gasReservePerPlayer: Int as coins;
    status: Int as uint8;
}

const STATUS_NONE: Int = 0;
const STATUS_ACTIVE: Int = 1;
const STATUS_SETTLED: Int = 2;

const REASON_NORMAL: Int = 0;
const REASON_DRAW: Int = 1;
const REASON_DISCONNECT: Int = 2;

const PLATFORM_FEE_BPS: Int = 300;
const FEE_DENOMINATOR: Int = 10000;

contract Skills2CryptoEscrowTON with Deployable, Ownable {

    owner: Address;
    oracle: Address;
    platformWallet: Address;
    gasPriceInTon: Int as coins;
    estimatedSettlementGas: Int as coins;
    gasReserveMultiplier: Int as uint32;

    sessions: map<Address, SessionKey>;
    matches: map<Int, MatchData>;

    init(oracle: Address, platformWallet: Address, gasPriceInTon: Int) {
        self.owner = sender();
        self.oracle = oracle;
        self.platformWallet = platformWallet;
        self.gasPriceInTon = gasPriceInTon;
        self.estimatedSettlementGas = ton("0.05");
        self.gasReserveMultiplier = 150;
    }

    receive(msg: RegisterSession) {
        let player: Address = sender();
        require(msg.expiry > now(), "Already expired");
        require(msg.expiry <= now() + 365 * 86400, "Max 365 days");
        require(msg.maxStake > 0, "Zero max stake");

        let session: SessionKey = SessionKey{
            player: player,
            sessionAddr: msg.sessionAddr,
            maxStake: msg.maxStake,
            expiry: msg.expiry,
            revoked: false,
            active: true
        };
        self.sessions.set(player, session);
    }

    receive(msg: RevokeSession) {
        let player: Address = sender();
        let session: SessionKey? = self.sessions.get(player);
        require(session != null, "No session");
        let s: SessionKey = session!!;
        require(s.player == player, "Not owner");
        s.revoked = true;
        self.sessions.set(player, s);
    }

    receive(msg: Deposit) {
        require(sender() == self.oracle, "Only oracle");

        let existing: MatchData? = self.matches.get(msg.matchId);
        require(existing == null, "Match exists");
        require(msg.player1 != msg.player2, "Same player");
        require(msg.stake > 0, "Zero stake");

        let s1: SessionKey? = self.sessions.get(msg.player1);
        let s2: SessionKey? = self.sessions.get(msg.player2);
        require(s1 != null, "P1 no session");
        require(s2 != null, "P2 no session");

        let session1: SessionKey = s1!!;
        let session2: SessionKey = s2!!;
        require(!session1.revoked, "P1 session revoked");
        require(!session2.revoked, "P2 session revoked");
        require(session1.expiry > now(), "P1 session expired");
        require(session2.expiry > now(), "P2 session expired");
        require(msg.stake <= session1.maxStake, "P1 stake too high");
        require(msg.stake <= session2.maxStake, "P2 stake too high");

        let gasReserve: Int = self.calculateGasReserve();
        let totalPerPlayer: Int = msg.stake + gasReserve;
        let totalRequired: Int = totalPerPlayer * 2;

        require(context().value >= totalRequired, "Insufficient TON sent");

        let matchData: MatchData = MatchData{
            matchId: msg.matchId,
            player1: msg.player1,
            player2: msg.player2,
            stake: msg.stake,
            gasReservePerPlayer: gasReserve,
            status: STATUS_ACTIVE
        };
        self.matches.set(msg.matchId, matchData);

        let excess: Int = context().value - totalRequired;
        if (excess > ton("0.01")) {
            send(SendParameters{
                to: sender(),
                value: excess,
                mode: SendPayGasSeparately,
                body: "Excess return".asComment()
            });
        }
    }

    receive(msg: Settle) {
        require(sender() == self.oracle, "Only oracle");
        require(msg.reason >= REASON_NORMAL && msg.reason <= REASON_DISCONNECT, "Invalid reason");

        let existing: MatchData? = self.matches.get(msg.matchId);
        require(existing != null, "Match not found");

        let m: MatchData = existing!!;
        require(m.status == STATUS_ACTIVE, "Not active");

        m.status = STATUS_SETTLED;
        self.matches.set(msg.matchId, m);

        let totalStake: Int = m.stake * 2;
        let totalGasReserve: Int = m.gasReservePerPlayer * 2;
        let halfGasReserve: Int = totalGasReserve / 2;
        let otherHalfGasReserve: Int = totalGasReserve - halfGasReserve;

        if (msg.reason == REASON_NORMAL) {
            require(msg.winner == m.player1 || msg.winner == m.player2, "Invalid winner");

            let platformFee: Int = (totalStake * PLATFORM_FEE_BPS) / FEE_DENOMINATOR;
            let payout: Int = totalStake - platformFee;

            send(SendParameters{
                to: msg.winner,
                value: payout + halfGasReserve,
                mode: SendPayGasSeparately,
                body: "Win payout + gas return".asComment()
            });

            let loser: Address = msg.winner == m.player1 ? m.player2 : m.player1;
            send(SendParameters{
                to: loser,
                value: otherHalfGasReserve,
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
                value: refundPerPlayer + halfGasReserve,
                mode: SendPayGasSeparately,
                body: "Draw refund + gas return".asComment()
            });
            send(SendParameters{
                to: m.player2,
                value: refundPerPlayer + otherHalfGasReserve,
                mode: SendPayGasSeparately,
                body: "Draw refund + gas return".asComment()
            });
            send(SendParameters{
                to: self.platformWallet,
                value: platformFee,
                mode: SendPayGasSeparately,
                body: "Platform fee".asComment()
            });

        } else if (msg.reason == REASON_DISCONNECT) {
            send(SendParameters{
                to: m.player1,
                value: m.stake + halfGasReserve,
                mode: SendPayGasSeparately,
                body: "Disconnect refund + gas return".asComment()
            });
            send(SendParameters{
                to: m.player2,
                value: m.stake + otherHalfGasReserve,
                mode: SendPayGasSeparately,
                body: "Disconnect refund + gas return".asComment()
            });
        }
    }

    receive(msg: UpdateGasPrice) {
        require(sender() == self.oracle, "Only oracle");
        require(msg.gasPriceInTon > 0, "Zero gas price");
        self.gasPriceInTon = msg.gasPriceInTon;
    }

    receive(msg: SetOracle) {
        self.requireOwner();
        self.oracle = msg.newOracle;
    }

    receive(msg: SetPlatformWallet) {
        self.requireOwner();
        self.platformWallet = msg.newWallet;
    }

    fun calculateGasReserve(): Int {
        return (self.gasPriceInTon * self.gasReserveMultiplier) / 100;
    }

    get fun getMatch(matchId: Int): MatchData? {
        return self.matches.get(matchId);
    }

    get fun getSession(player: Address): SessionKey? {
        return self.sessions.get(player);
    }

    get fun getGasReserveEstimate(): Int {
        return self.calculateGasReserve();
    }

    get fun getOracle(): Address {
        return self.oracle;
    }

    get fun getPlatformWallet(): Address {
        return self.platformWallet;
    }

    get fun getGasPriceInTon(): Int {
        return self.gasPriceInTon;
    }
}
