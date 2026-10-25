// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// DISPOSABLE SHASTA FIXTURE, NOT MAINNET USDT.
contract ProofToken is ERC20 {
    address public immutable issuer = msg.sender;
    constructor() ERC20("Shasta Proof Token - No Value", "PROOF") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external {
        require(msg.sender == issuer, "issuer only");
        _mint(to, amount);
    }
}

// Test-only approximation of the paired-deposit authorization flow.
// Same EIP-712 message shapes; direct 1% resource fee; NO swap logic.
// This is NOT the final production replacement contract.
contract ProofEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    IERC20 public immutable token;
    address public immutable oracle;
    address public immutable platform;
    address public immutable resourceTreasury;
    uint256 public constant platformFeeBps = 300;
    uint256 public constant resourceFeeBps = 100;
    bytes32 private constant DEPOSIT = keccak256(
        "Deposit(bytes32 matchId,uint256 stake,uint256 nonce)"
    );
    bytes32 private constant OUTCOME = keccak256(
        "MatchOutcome(bytes32 matchId,address winner,uint8 reason)"
    );
    struct Match {
        address player1;
        address player2;
        uint256 stake;
        uint8 status;
    }
    mapping(bytes32 => Match) public matches;
    mapping(address => uint256) public depositNonces;

    constructor(address t, address o, address p, address r)
        EIP712("Skills2CryptoEscrow", "2")
    {
        require(t != address(0) && o != address(0) &&
            p != address(0) && r != address(0), "zero address");
        token = IERC20(t);
        oracle = o;
        platform = p;
        resourceTreasury = r;
    }
    modifier onlyOracle() { require(msg.sender == oracle, "oracle only"); _; }
    function chainId() external view returns (uint256) { return block.chainid; }

    function depositUSDTGasless(
        bytes32 id, address a, address b, uint256 stake,
        bytes calldata sa, bytes calldata sb
    ) external onlyOracle nonReentrant {
        require(matches[id].status == 0 && a != b && stake > 0, "invalid match");
        require(a != address(0) && b != address(0), "zero player");
        _authorize(id, a, stake, sa);
        _authorize(id, b, stake, sb);
        token.safeTransferFrom(a, address(this), stake);
        token.safeTransferFrom(b, address(this), stake);
        matches[id] = Match(a, b, stake, 1);
    }

    function _authorize(bytes32 id, address player, uint256 stake, bytes calldata sig) private {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            DEPOSIT, id, stake, depositNonces[player]
        )));
        require(digest.recover(sig) == player, "invalid signature");
        depositNonces[player]++;
    }

    function settleMatch(bytes32 id, address winner, uint8 reason, bytes calldata sig)
        external onlyOracle nonReentrant
    {
        Match storage m = matches[id];
        require(m.status == 1 && reason <= 2, "invalid settlement");
        require(_hashTypedDataV4(keccak256(abi.encode(
            OUTCOME, id, winner, reason
        ))).recover(sig) == oracle, "invalid outcome");
        m.status = 2;
        uint256 pot = m.stake * 2;
        uint256 baseFee = reason == 2 ? 0 : pot * platformFeeBps / 10_000;
        uint256 resourceFee = pot * resourceFeeBps / 10_000;
        if (reason == 0) {
            require(winner == m.player1 || winner == m.player2, "invalid winner");
            token.safeTransfer(winner, pot - baseFee - resourceFee);
        } else {
            require(winner == address(0), "unexpected winner");
            uint256 refund = m.stake - baseFee / 2 - resourceFee / 2;
            token.safeTransfer(m.player1, refund);
            token.safeTransfer(m.player2, refund);
        }
        if (baseFee != 0) token.safeTransfer(platform, baseFee);
        token.safeTransfer(resourceTreasury, resourceFee);
    }
}
