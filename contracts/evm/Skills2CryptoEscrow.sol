// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

contract Skills2CryptoEscrow is Ownable, ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    enum MatchStatus { None, Active, Settled }
    enum SettleReason { Normal, Draw, Disconnect }
    enum AssetType { USDT, NativeCoin }

    struct SessionKey {
        address player;
        address sessionAddr;
        uint256 maxStakePerMatch;
        uint256 expiry;
        bool revoked;
    }

    struct Match {
        bytes32 matchId;
        address player1;
        address player2;
        uint256 stake;
        AssetType assetType;
        uint256 gasReservePerPlayer;
        MatchStatus status;
    }

    IERC20 public immutable usdtToken;
    uint8 public immutable usdtDecimals;
    address public platformWallet;
    address public oracle;
    uint256 public platformFeeBps = 300;
    uint256 public gasReserveMultiplier = 150;
    uint256 public gasPriceInUsdtPerGasUnit;
    uint256 public estimatedSettlementGas = 200_000;

    bytes32 private constant SESSION_TYPEHASH = keccak256(
        "SessionKey(address player,address sessionAddr,uint256 maxStakePerMatch,uint256 expiry,uint256 nonce)"
    );

    bytes32 private constant DEPOSIT_TYPEHASH = keccak256(
        "Deposit(bytes32 matchId,uint256 stake,uint8 assetType,uint256 nonce)"
    );

    mapping(bytes32 => Match) public matches;
    mapping(address => SessionKey) public sessionKeys;
    mapping(address => uint256) public sessionNonces;
    mapping(address => uint256) public depositNonces;

    event SessionKeyRegistered(address indexed player, address indexed sessionAddr, uint256 expiry);
    event SessionKeyRevoked(address indexed player);
    event MatchActive(bytes32 indexed matchId, address player1, address player2, uint256 stake, AssetType assetType, uint256 gasReservePerPlayer);
    event MatchSettled(bytes32 indexed matchId, address winner, SettleReason reason, uint256 payout, uint256 platformFee);
    event GasPriceUpdated(uint256 newGasPriceInUsdtPerGasUnit);
    event GasReserveReturned(bytes32 indexed matchId, address player, uint256 amount);
    event OracleUpdated(address newOracle);
    event PlatformWalletUpdated(address newWallet);

    modifier onlyOracle() {
        require(msg.sender == oracle, "Only oracle");
        _;
    }

    constructor(
        address _usdtToken,
        uint8 _usdtDecimals,
        address _platformWallet,
        address _oracle,
        uint256 _initialGasPricePerUnit
    ) Ownable(msg.sender) EIP712("Skills2CryptoEscrow", "1") {
        require(_usdtToken != address(0), "Zero USDT address");
        require(_platformWallet != address(0), "Zero platform wallet");
        require(_oracle != address(0), "Zero oracle");
        usdtToken = IERC20(_usdtToken);
        usdtDecimals = _usdtDecimals;
        platformWallet = _platformWallet;
        oracle = _oracle;
        gasPriceInUsdtPerGasUnit = _initialGasPricePerUnit;
    }

    function registerSessionKey(
        address player,
        address sessionAddr,
        uint256 maxStakePerMatch,
        uint256 expiry,
        bytes calldata signature
    ) external {
        require(player != address(0), "Zero player");
        require(sessionAddr != address(0), "Zero session addr");
        require(maxStakePerMatch > 0, "Zero max stake");
        require(expiry > block.timestamp, "Already expired");
        require(expiry <= block.timestamp + 365 days, "Max 365 days");

        uint256 nonce = sessionNonces[player];
        bytes32 structHash = keccak256(abi.encode(
            SESSION_TYPEHASH,
            player,
            sessionAddr,
            maxStakePerMatch,
            expiry,
            nonce
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = digest.recover(signature);
        require(signer == player, "Invalid session signature");

        sessionKeys[player] = SessionKey({
            player: player,
            sessionAddr: sessionAddr,
            maxStakePerMatch: maxStakePerMatch,
            expiry: expiry,
            revoked: false
        });
        sessionNonces[player] = nonce + 1;

        emit SessionKeyRegistered(player, sessionAddr, expiry);
    }

    function revokeSessionKey() external {
        require(sessionKeys[msg.sender].player == msg.sender, "No session key");
        sessionKeys[msg.sender].revoked = true;
        emit SessionKeyRevoked(msg.sender);
    }

    function _validateSession(address player, uint256 stake) internal view {
        SessionKey storage sk = sessionKeys[player];
        require(sk.player == player, "No session key");
        require(!sk.revoked, "Session revoked");
        require(block.timestamp < sk.expiry, "Session expired");
        require(stake <= sk.maxStakePerMatch, "Stake exceeds session limit");
    }

    function _calculateGasReserve() internal view returns (uint256) {
        return (estimatedSettlementGas * gasPriceInUsdtPerGasUnit * gasReserveMultiplier) / 100;
    }

    function depositUSDT(
        bytes32 matchId,
        uint256 stake,
        address player1,
        address player2,
        bytes calldata sig1,
        bytes calldata sig2
    ) external onlyOracle nonReentrant {
        require(matches[matchId].status == MatchStatus.None, "Match exists");
        require(player1 != player2, "Same player");
        require(player1 != address(0) && player2 != address(0), "Zero address");
        require(stake > 0, "Zero stake");

        _validateSession(player1, stake);
        _validateSession(player2, stake);

        _verifyDepositSignature(matchId, stake, AssetType.USDT, player1, sig1);
        _verifyDepositSignature(matchId, stake, AssetType.USDT, player2, sig2);

        uint256 gasReserve = _calculateGasReserve();
        uint256 totalPerPlayer = stake + gasReserve;

        usdtToken.safeTransferFrom(player1, address(this), totalPerPlayer);
        usdtToken.safeTransferFrom(player2, address(this), totalPerPlayer);

        matches[matchId] = Match({
            matchId: matchId,
            player1: player1,
            player2: player2,
            stake: stake,
            assetType: AssetType.USDT,
            gasReservePerPlayer: gasReserve,
            status: MatchStatus.Active
        });

        emit MatchActive(matchId, player1, player2, stake, AssetType.USDT, gasReserve);
    }

    struct PermitData {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function depositUSDTWithPermit(
        bytes32 matchId,
        uint256 stake,
        address player1,
        address player2,
        bytes calldata sig1,
        bytes calldata sig2,
        PermitData calldata permit1,
        PermitData calldata permit2
    ) external onlyOracle nonReentrant {
        require(matches[matchId].status == MatchStatus.None, "Match exists");
        require(player1 != player2, "Same player");
        require(player1 != address(0) && player2 != address(0), "Zero address");
        require(stake > 0, "Zero stake");

        _validateSession(player1, stake);
        _validateSession(player2, stake);

        _verifyDepositSignature(matchId, stake, AssetType.USDT, player1, sig1);
        _verifyDepositSignature(matchId, stake, AssetType.USDT, player2, sig2);

        uint256 gasReserve = _calculateGasReserve();
        uint256 totalPerPlayer = stake + gasReserve;

        _tryPermit(player1, permit1);
        _tryPermit(player2, permit2);

        usdtToken.safeTransferFrom(player1, address(this), totalPerPlayer);
        usdtToken.safeTransferFrom(player2, address(this), totalPerPlayer);

        uint256 totalGasReserve = gasReserve * 2;
        if (totalGasReserve > 0) {
            usdtToken.safeTransfer(oracle, totalGasReserve);
        }

        matches[matchId] = Match({
            matchId: matchId,
            player1: player1,
            player2: player2,
            stake: stake,
            assetType: AssetType.USDT,
            gasReservePerPlayer: 0,
            status: MatchStatus.Active
        });

        emit MatchActive(matchId, player1, player2, stake, AssetType.USDT, gasReserve);
    }

    function _tryPermit(address owner, PermitData calldata pd) internal {
        if (pd.deadline > 0) {
            try IERC20Permit(address(usdtToken)).permit(
                owner,
                address(this),
                type(uint256).max,
                pd.deadline,
                pd.v,
                pd.r,
                pd.s
            ) {} catch {}
        }
    }

    function depositNative(
        bytes32 matchId,
        uint256 stake,
        address player1,
        address player2,
        bytes calldata sig1,
        bytes calldata sig2
    ) external payable onlyOracle nonReentrant {
        require(matches[matchId].status == MatchStatus.None, "Match exists");
        require(player1 != player2, "Same player");
        require(player1 != address(0) && player2 != address(0), "Zero address");
        require(stake > 0, "Zero stake");

        _validateSession(player1, stake);
        _validateSession(player2, stake);

        _verifyDepositSignature(matchId, stake, AssetType.NativeCoin, player1, sig1);
        _verifyDepositSignature(matchId, stake, AssetType.NativeCoin, player2, sig2);

        uint256 gasReserve = _calculateGasReserve();
        uint256 totalPerPlayer = stake + gasReserve;
        require(msg.value == totalPerPlayer * 2, "Incorrect native amount");

        matches[matchId] = Match({
            matchId: matchId,
            player1: player1,
            player2: player2,
            stake: stake,
            assetType: AssetType.NativeCoin,
            gasReservePerPlayer: gasReserve,
            status: MatchStatus.Active
        });

        emit MatchActive(matchId, player1, player2, stake, AssetType.NativeCoin, gasReserve);
    }

    function _verifyDepositSignature(
        bytes32 matchId,
        uint256 stake,
        AssetType assetType,
        address player,
        bytes calldata sig
    ) internal {
        uint256 nonce = depositNonces[player];
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            DEPOSIT_TYPEHASH, matchId, stake, uint8(assetType), nonce
        )));
        address signer = digest.recover(sig);
        require(
            signer == player || signer == sessionKeys[player].sessionAddr,
            "Invalid deposit signature"
        );
        depositNonces[player] = nonce + 1;
    }

    function settleMatch(
        bytes32 matchId,
        address winner,
        SettleReason reason
    ) external onlyOracle nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.Active, "Not active");

        m.status = MatchStatus.Settled;

        uint256 totalStake = m.stake * 2;
        uint256 totalGasReserve = m.gasReservePerPlayer * 2;
        uint256 platformFee;
        uint256 payout;

        if (reason == SettleReason.Normal) {
            require(winner == m.player1 || winner == m.player2, "Invalid winner");
            platformFee = (totalStake * platformFeeBps) / 10_000;
            payout = totalStake - platformFee;

            _transfer(m.assetType, winner, payout);
            _transfer(m.assetType, platformWallet, platformFee);
            _returnGasReserve(matchId, m, totalGasReserve);

        } else if (reason == SettleReason.Draw) {
            platformFee = (totalStake * platformFeeBps) / 10_000;
            uint256 halfFee = platformFee / 2;
            uint256 refundPerPlayer = m.stake - halfFee;

            _transfer(m.assetType, m.player1, refundPerPlayer);
            _transfer(m.assetType, m.player2, refundPerPlayer);
            _transfer(m.assetType, platformWallet, platformFee);
            _returnGasReserve(matchId, m, totalGasReserve);

        } else if (reason == SettleReason.Disconnect) {
            _transfer(m.assetType, m.player1, m.stake);
            _transfer(m.assetType, m.player2, m.stake);
            _returnGasReserve(matchId, m, totalGasReserve);
            platformFee = 0;
            payout = m.stake;

        } else {
            revert("Invalid settle reason");
        }

        emit MatchSettled(matchId, winner, reason, payout, platformFee);
    }

    function _returnGasReserve(bytes32 matchId, Match storage m, uint256 totalReserve) internal {
        if (totalReserve > 0) {
            uint256 half = totalReserve / 2;
            uint256 otherHalf = totalReserve - half;
            _transfer(m.assetType, m.player1, half);
            _transfer(m.assetType, m.player2, otherHalf);
            emit GasReserveReturned(matchId, m.player1, half);
            emit GasReserveReturned(matchId, m.player2, otherHalf);
        }
    }

    function _transfer(AssetType assetType, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (assetType == AssetType.USDT) {
            usdtToken.safeTransfer(to, amount);
        } else {
            (bool ok,) = payable(to).call{value: amount}("");
            require(ok, "Native transfer failed");
        }
    }

    function updateGasPrice(uint256 _gasPricePerGasUnit) external onlyOracle {
        gasPriceInUsdtPerGasUnit = _gasPricePerGasUnit;
        emit GasPriceUpdated(_gasPricePerGasUnit);
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

    function setEstimatedSettlementGas(uint256 _gas) external onlyOwner {
        require(_gas > 0, "Zero gas");
        estimatedSettlementGas = _gas;
    }

    function setGasReserveMultiplier(uint256 _multiplier) external onlyOwner {
        require(_multiplier >= 100 && _multiplier <= 300, "100-300 range");
        gasReserveMultiplier = _multiplier;
    }

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function getSessionKey(address player) external view returns (SessionKey memory) {
        return sessionKeys[player];
    }

    function getDepositNonce(address player) external view returns (uint256) {
        return depositNonces[player];
    }

    function getGasReserveEstimate() external view returns (uint256) {
        return _calculateGasReserve();
    }

    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    receive() external payable {}
}
