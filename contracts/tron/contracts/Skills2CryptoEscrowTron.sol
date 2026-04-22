// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISunSwapV2Router {
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}

/**
 * Skills2CryptoEscrowTron — gasless USDT TRC-20 escrow for Tron.
 *
 * Architecture (Task #16 rewrite):
 *   - Each player makes ONE-TIME approve(escrow, MAX) using their own TRX.
 *     After that, every match is gasless for the player.
 *   - Deposits and settlements are submitted by the oracle wallet (which
 *     pays all TRX gas). The contract verifies EIP-712 signatures from the
 *     players for deposits, and an EIP-712 oracle signature for settlement,
 *     so the oracle cannot move funds beyond what the players authorized.
 *   - The contract takes a 0.5% gas-fund fee from each settlement (in USDT)
 *     and accumulates it. When the accumulator crosses `swapThreshold` it
 *     auto-swaps to TRX via SunSwap V2 and forwards to the oracle gas-fund
 *     wallet — keeping the oracle solvent without manual top-ups.
 *
 * Payouts (per the spec):
 *   - Normal:     winner gets 2*stake - 3% platform - 0.5% gas fund
 *   - Draw:       each gets stake - 1.5% - 0.25%
 *   - Disconnect: each gets stake - 0.25% (no platform fee, but gas fund still
 *                 charged because the oracle still spent TRX on deposit + settle)
 */
contract Skills2CryptoEscrowTron is Ownable, ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    enum MatchStatus { None, Active, Settled }
    enum SettleReason { Normal, Draw, Disconnect }

    struct Match {
        address player1;
        address player2;
        uint256 stake;
        MatchStatus status;
    }

    IERC20 public immutable usdt;
    address public platformWallet;
    address public oracleGasFund;
    address public oracle;
    uint256 public platformFeeBps = 300; // 3.00%
    uint256 public gasFundFeeBps = 50;   // 0.50%

    address public sunSwapRouter;
    address public wtrx;
    uint256 public swapThreshold;        // smallest USDT units (6 decimals)
    uint256 public swapSlippageBps = 500; // 5%
    uint256 public accumulatedGasFundUSDT;

    bytes32 private constant DEPOSIT_TYPEHASH = keccak256(
        "Deposit(bytes32 matchId,uint256 stake,uint256 nonce)"
    );
    bytes32 private constant MATCH_OUTCOME_TYPEHASH = keccak256(
        "MatchOutcome(bytes32 matchId,address winner,uint8 reason)"
    );

    mapping(bytes32 => Match) public matches;
    mapping(address => uint256) public depositNonces;

    event MatchActive(bytes32 indexed matchId, address player1, address player2, uint256 stake);
    event MatchSettled(
        bytes32 indexed matchId,
        address winner,
        SettleReason reason,
        uint256 payout,
        uint256 platformFee,
        uint256 gasFundFee
    );
    event GasFundAccumulated(uint256 added, uint256 totalAccumulated);
    event GasFundSwapped(uint256 usdtIn, uint256 trxOut);
    event GasFundSwapFailed(uint256 usdtIn, string reason);
    event ConfigUpdated(string field);

    modifier onlyOracle() {
        require(msg.sender == oracle, "Only oracle");
        _;
    }

    constructor(
        address _usdt,
        address _platformWallet,
        address _oracle,
        address _oracleGasFund,
        address _sunSwapRouter,
        address _wtrx,
        uint256 _swapThreshold
    ) Ownable(msg.sender) EIP712("Skills2CryptoEscrow", "2") {
        require(
            _usdt != address(0) &&
            _platformWallet != address(0) &&
            _oracle != address(0) &&
            _oracleGasFund != address(0),
            "Zero address"
        );
        usdt = IERC20(_usdt);
        platformWallet = _platformWallet;
        oracle = _oracle;
        oracleGasFund = _oracleGasFund;
        sunSwapRouter = _sunSwapRouter;
        wtrx = _wtrx;
        swapThreshold = _swapThreshold;
    }

    /**
     * Oracle-submitted gasless deposit. Pulls `stake` USDT from each player
     * via their pre-existing approval. Both players' EIP-712 signatures
     * authorize this exact (matchId, stake, nonce).
     */
    function depositUSDTGasless(
        bytes32 matchId,
        address player1,
        address player2,
        uint256 stake,
        bytes calldata sig1,
        bytes calldata sig2
    ) external onlyOracle nonReentrant {
        require(matches[matchId].status == MatchStatus.None, "Match exists");
        require(player1 != player2, "Same player");
        require(player1 != address(0) && player2 != address(0), "Zero address");
        require(stake > 0, "Zero stake");

        _verifyAndConsumeDepositSig(matchId, stake, player1, sig1);
        _verifyAndConsumeDepositSig(matchId, stake, player2, sig2);

        usdt.safeTransferFrom(player1, address(this), stake);
        usdt.safeTransferFrom(player2, address(this), stake);

        matches[matchId] = Match({
            player1: player1,
            player2: player2,
            stake: stake,
            status: MatchStatus.Active
        });
        emit MatchActive(matchId, player1, player2, stake);
    }

    /**
     * Oracle-submitted settlement. The oracleSig is verified against the
     * stored oracle pubkey so a compromised oracle key is the only way to
     * steal funds (same trust model as the EVM contract).
     */
    function settleMatch(
        bytes32 matchId,
        address winner,
        SettleReason reason,
        bytes calldata oracleSig
    ) external onlyOracle nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.Active, "Not active");

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            MATCH_OUTCOME_TYPEHASH, matchId, winner, uint8(reason)
        )));
        require(digest.recover(oracleSig) == oracle, "Invalid oracle sig");

        m.status = MatchStatus.Settled;

        uint256 totalStake = m.stake * 2;
        uint256 platformFee = 0;
        uint256 gasFundFee = 0;
        uint256 payout = 0;

        if (reason == SettleReason.Normal) {
            require(winner == m.player1 || winner == m.player2, "Invalid winner");
            platformFee = (totalStake * platformFeeBps) / 10_000;
            gasFundFee = (totalStake * gasFundFeeBps) / 10_000;
            payout = totalStake - platformFee - gasFundFee;
            usdt.safeTransfer(winner, payout);
            usdt.safeTransfer(platformWallet, platformFee);
        } else if (reason == SettleReason.Draw) {
            require(winner == address(0), "Winner must be zero");
            platformFee = (totalStake * platformFeeBps) / 10_000;
            gasFundFee = (totalStake * gasFundFeeBps) / 10_000;
            uint256 halfPlatform = platformFee / 2;
            uint256 halfGasFund = gasFundFee / 2;
            uint256 refundPerPlayer = m.stake - halfPlatform - halfGasFund;
            usdt.safeTransfer(m.player1, refundPerPlayer);
            usdt.safeTransfer(m.player2, refundPerPlayer);
            usdt.safeTransfer(platformWallet, platformFee);
        } else {
            // Disconnect: no platform fee, but gas fund still charged because
            // the oracle paid TRX for both deposit and settle transactions.
            require(winner == address(0), "Winner must be zero");
            gasFundFee = (totalStake * gasFundFeeBps) / 10_000;
            uint256 halfGasFund = gasFundFee / 2;
            uint256 refundPerPlayer = m.stake - halfGasFund;
            usdt.safeTransfer(m.player1, refundPerPlayer);
            usdt.safeTransfer(m.player2, refundPerPlayer);
        }

        if (gasFundFee > 0) {
            accumulatedGasFundUSDT += gasFundFee;
            emit GasFundAccumulated(gasFundFee, accumulatedGasFundUSDT);
            _maybeSwapGasFund();
        }

        emit MatchSettled(matchId, winner, reason, payout, platformFee, gasFundFee);
    }

    function _verifyAndConsumeDepositSig(
        bytes32 matchId,
        uint256 stake,
        address player,
        bytes calldata sig
    ) internal {
        uint256 nonce = depositNonces[player];
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            DEPOSIT_TYPEHASH, matchId, stake, nonce
        )));
        require(digest.recover(sig) == player, "Invalid deposit sig");
        depositNonces[player] = nonce + 1;
    }

    function _maybeSwapGasFund() internal {
        if (accumulatedGasFundUSDT < swapThreshold) return;
        uint256 amountIn = accumulatedGasFundUSDT;
        accumulatedGasFundUSDT = 0;

        IERC20(address(usdt)).forceApprove(sunSwapRouter, amountIn);

        address[] memory path = new address[](2);
        path[0] = address(usdt);
        path[1] = wtrx;

        try ISunSwapV2Router(sunSwapRouter).getAmountsOut(amountIn, path) returns (uint256[] memory expected) {
            uint256 minOut = (expected[1] * (10_000 - swapSlippageBps)) / 10_000;
            try ISunSwapV2Router(sunSwapRouter).swapExactTokensForETH(
                amountIn,
                minOut,
                path,
                oracleGasFund,
                block.timestamp + 600
            ) returns (uint256[] memory amounts) {
                emit GasFundSwapped(amountIn, amounts[1]);
            } catch {
                accumulatedGasFundUSDT = amountIn;
                emit GasFundSwapFailed(amountIn, "swap_reverted");
            }
        } catch {
            accumulatedGasFundUSDT = amountIn;
            emit GasFundSwapFailed(amountIn, "getAmountsOut_reverted");
        }
    }

    /**
     * Manual swap trigger — useful when auto-swap was deferred by transient
     * SunSwap pool issues; owner can retry without waiting for the next
     * settlement to push past the threshold again.
     */
    function triggerGasFundSwap() external onlyOwner {
        require(accumulatedGasFundUSDT > 0, "Nothing to swap");
        _maybeSwapGasFund();
    }

    function setOracle(address a) external onlyOwner {
        require(a != address(0), "Zero");
        oracle = a;
        emit ConfigUpdated("oracle");
    }

    function setPlatformWallet(address a) external onlyOwner {
        require(a != address(0), "Zero");
        platformWallet = a;
        emit ConfigUpdated("platformWallet");
    }

    function setOracleGasFund(address a) external onlyOwner {
        require(a != address(0), "Zero");
        oracleGasFund = a;
        emit ConfigUpdated("oracleGasFund");
    }

    function setSunSwapRouter(address a) external onlyOwner {
        require(a != address(0), "Zero");
        sunSwapRouter = a;
        emit ConfigUpdated("router");
    }

    function setSwapThreshold(uint256 v) external onlyOwner {
        swapThreshold = v;
        emit ConfigUpdated("swapThreshold");
    }

    function setSwapSlippageBps(uint256 v) external onlyOwner {
        require(v <= 2000, "Max 20%");
        swapSlippageBps = v;
        emit ConfigUpdated("swapSlippage");
    }

    function setPlatformFeeBps(uint256 v) external onlyOwner {
        require(v <= 1000, "Max 10%");
        platformFeeBps = v;
        emit ConfigUpdated("platformFee");
    }

    function setGasFundFeeBps(uint256 v) external onlyOwner {
        require(v <= 200, "Max 2%");
        gasFundFeeBps = v;
        emit ConfigUpdated("gasFundFee");
    }

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function getDepositNonce(address player) external view returns (uint256) {
        return depositNonces[player];
    }

    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
