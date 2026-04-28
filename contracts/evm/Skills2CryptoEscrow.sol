// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * Skills2CryptoEscrow V2 — native-coin escrow for BSC and Ethereum.
 *
 * Architecture (Task #16 rewrite):
 *   1. Server (oracle) signs MatchAuth(matchId, p1, p2, stake, deadline)
 *      off-chain after matchmaking pairs two players.
 *   2. Each player calls depositNative(...) with msg.value == stake from
 *      their own wallet, paying their own gas. Second deposit transitions
 *      the match to Active and emits MatchActive (server listens for this).
 *   3. After the game ends off-chain, the oracle signs
 *      MatchOutcome(matchId, winner, reason) off-chain.
 *   4. The winner (Normal) or either player (Draw/Disconnect) calls
 *      settleMatch(matchId, winner, reason, oracleSig). The contract verifies
 *      the oracle signature, then pays out per the rules below. The caller
 *      pays the settle gas — the oracle never broadcasts a transaction.
 *
 * Payouts:
 *   - Normal:     winner gets 2*stake - 3% platform fee
 *   - Draw:       each gets stake - 1.5% (half of 3% applied to each side)
 *   - Disconnect: each gets full stake (no fee — neither player completed)
 */
/**
 * Pausable: only `depositNative` is gated. Settlement, refundNoShow, and
 * the owner setters MUST stay reachable when paused so funds escrowed
 * before the pause can always exit per the rules. The pause lever is
 * intended as an incident-response brake on NEW money entering the
 * contract — never as a way to trap existing matches.
 */
contract Skills2CryptoEscrow is Ownable, ReentrancyGuard, Pausable, EIP712 {
    using ECDSA for bytes32;

    enum MatchStatus { None, WaitingForP2, Active, Settled }
    enum SettleReason { Normal, Draw, Disconnect }

    struct Match {
        address player1;
        address player2;
        uint256 stake;
        uint256 deadline;
        address firstDepositor;
        MatchStatus status;
    }

    address public platformWallet;
    address public oracle;
    uint256 public platformFeeBps = 300; // 3.00%

    bytes32 private constant MATCH_AUTH_TYPEHASH = keccak256(
        "MatchAuth(bytes32 matchId,address player1,address player2,uint256 stake,uint256 deadline)"
    );
    bytes32 private constant MATCH_OUTCOME_TYPEHASH = keccak256(
        "MatchOutcome(bytes32 matchId,address winner,uint8 reason)"
    );

    mapping(bytes32 => Match) public matches;

    event PlayerDeposited(bytes32 indexed matchId, address indexed player, uint256 amount);
    event MatchActive(bytes32 indexed matchId, address player1, address player2, uint256 stake);
    event MatchSettled(
        bytes32 indexed matchId,
        address winner,
        SettleReason reason,
        uint256 payout,
        uint256 platformFee
    );
    event RefundedNoShow(bytes32 indexed matchId, address indexed player, uint256 amount);
    event OracleUpdated(address newOracle);
    event PlatformWalletUpdated(address newWallet);
    event PlatformFeeUpdated(uint256 newBps);

    constructor(address _platformWallet, address _oracle)
        Ownable(msg.sender)
        EIP712("Skills2CryptoEscrow", "2")
    {
        require(_platformWallet != address(0), "Zero platform wallet");
        require(_oracle != address(0), "Zero oracle");
        platformWallet = _platformWallet;
        oracle = _oracle;
    }

    function depositNative(
        bytes32 matchId,
        address player1,
        address player2,
        uint256 stake,
        uint256 deadline,
        bytes calldata oracleSig
    ) external payable nonReentrant whenNotPaused {
        require(player1 != player2, "Same player");
        require(player1 != address(0) && player2 != address(0), "Zero address");
        require(stake > 0, "Zero stake");
        require(block.timestamp <= deadline, "Auth expired");
        require(msg.sender == player1 || msg.sender == player2, "Not a player");
        require(msg.value == stake, "Incorrect deposit");

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            MATCH_AUTH_TYPEHASH, matchId, player1, player2, stake, deadline
        )));
        require(digest.recover(oracleSig) == oracle, "Invalid oracle sig");

        Match storage m = matches[matchId];
        if (m.status == MatchStatus.None) {
            matches[matchId] = Match({
                player1: player1,
                player2: player2,
                stake: stake,
                deadline: deadline,
                firstDepositor: msg.sender,
                status: MatchStatus.WaitingForP2
            });
            emit PlayerDeposited(matchId, msg.sender, stake);
        } else if (m.status == MatchStatus.WaitingForP2) {
            require(m.player1 == player1 && m.player2 == player2, "Player mismatch");
            require(m.stake == stake, "Stake mismatch");
            require(m.deadline == deadline, "Deadline mismatch");
            require(msg.sender != m.firstDepositor, "Already deposited");
            m.status = MatchStatus.Active;
            emit PlayerDeposited(matchId, msg.sender, stake);
            emit MatchActive(matchId, player1, player2, stake);
        } else {
            revert("Invalid match state");
        }
    }

    /**
     * If only one player ever deposited and the auth deadline has passed,
     * that player can recover their stake.
     */
    function refundNoShow(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.WaitingForP2, "Not waiting");
        require(block.timestamp > m.deadline, "Not expired yet");
        require(msg.sender == m.firstDepositor, "Only first depositor");
        uint256 refund = m.stake;
        m.status = MatchStatus.Settled;
        (bool ok, ) = payable(msg.sender).call{value: refund}("");
        require(ok, "Refund failed");
        emit RefundedNoShow(matchId, msg.sender, refund);
    }

    /**
     * Settle a match. Caller pays gas.
     *
     * Authorization:
     *   - Normal:     msg.sender MUST be the winner address.
     *   - Draw:       msg.sender MUST be one of the two players, winner == address(0).
     *   - Disconnect: msg.sender MUST be one of the two players, winner == address(0).
     *
     * The oracleSig binds (matchId, winner, reason) so the caller cannot
     * pass a different reason or steal the pot.
     */
    function settleMatch(
        bytes32 matchId,
        address winner,
        SettleReason reason,
        bytes calldata oracleSig
    ) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.Active, "Not active");

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            MATCH_OUTCOME_TYPEHASH, matchId, winner, uint8(reason)
        )));
        require(digest.recover(oracleSig) == oracle, "Invalid oracle sig");

        if (reason == SettleReason.Normal) {
            require(winner == m.player1 || winner == m.player2, "Invalid winner");
            require(msg.sender == winner, "Only winner can claim");
        } else {
            require(winner == address(0), "Winner must be zero for non-Normal");
            require(msg.sender == m.player1 || msg.sender == m.player2, "Only player");
        }

        m.status = MatchStatus.Settled;

        uint256 totalStake = m.stake * 2;
        uint256 platformFee = 0;
        uint256 payout = 0;

        if (reason == SettleReason.Normal) {
            platformFee = (totalStake * platformFeeBps) / 10_000;
            payout = totalStake - platformFee;
            _transferNative(winner, payout);
            _transferNative(platformWallet, platformFee);
        } else if (reason == SettleReason.Draw) {
            platformFee = (totalStake * platformFeeBps) / 10_000;
            uint256 halfFee = platformFee / 2;
            uint256 refundPerPlayer = m.stake - halfFee;
            _transferNative(m.player1, refundPerPlayer);
            _transferNative(m.player2, refundPerPlayer);
            _transferNative(platformWallet, platformFee);
        } else {
            // Disconnect: full refund, no fee.
            _transferNative(m.player1, m.stake);
            _transferNative(m.player2, m.stake);
        }

        emit MatchSettled(matchId, winner, reason, payout, platformFee);
    }

    function _transferNative(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Native transfer failed");
    }

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Zero oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }

    function setPlatformWallet(address _wallet) external onlyOwner {
        require(_wallet != address(0), "Zero wallet");
        platformWallet = _wallet;
        emit PlatformWalletUpdated(_wallet);
    }

    function setPlatformFeeBps(uint256 _bps) external onlyOwner {
        require(_bps <= 1000, "Max 10%");
        platformFeeBps = _bps;
        emit PlatformFeeUpdated(_bps);
    }

    /**
     * Owner-only emergency brake. When paused, no NEW deposits are
     * accepted — settlement, refundNoShow and all setters remain
     * available so in-flight matches can always resolve and the
     * operator can recover.
     *
     * Recommended deployment: transfer ownership to a Gnosis Safe
     * multisig + (optionally) a TimelockController so a single
     * compromised key cannot pause or change parameters unilaterally.
     */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    receive() external payable {}
}
