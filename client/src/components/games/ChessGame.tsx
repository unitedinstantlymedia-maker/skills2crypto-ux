
import { useState, useCallback, useEffect, useRef } from "react";
import { Chess, Square } from "chess.js";
import { useLanguage } from "@/context/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Crown, Flag } from "lucide-react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";

type Result = "win" | "loss" | "draw";

interface ChessGameProps {
  onFinish: (result: Result) => void;
}

// Chess piece 3D models (simplified geometric shapes)
function ChessPiece({ 
  position, 
  type, 
  color, 
  onClick 
}: { 
  position: [number, number, number]; 
  type: string; 
  color: "white" | "black";
  onClick: () => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (meshRef.current) {
      document.body.style.cursor = hovered ? "pointer" : "auto";
    }
  }, [hovered]);

  const pieceColor = color === "white" ? "#f0f0f0" : "#333333";
  const emissive = hovered ? "#4a9eff" : "#000000";

  // Simple geometric representation of pieces
  const getPieceGeometry = () => {
    switch (type.toLowerCase()) {
      case "k": // King
        return (
          <group>
            <mesh position={[0, 0.3, 0]}>
              <cylinderGeometry args={[0.15, 0.25, 0.6, 8]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
            <mesh position={[0, 0.7, 0]}>
              <boxGeometry args={[0.15, 0.2, 0.05]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
            <mesh position={[0, 0.7, 0]}>
              <boxGeometry args={[0.05, 0.2, 0.15]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
          </group>
        );
      case "q": // Queen
        return (
          <group>
            <mesh position={[0, 0.3, 0]}>
              <cylinderGeometry args={[0.15, 0.25, 0.6, 8]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
            <mesh position={[0, 0.65, 0]}>
              <sphereGeometry args={[0.15, 8, 8]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
          </group>
        );
      case "r": // Rook
        return (
          <mesh position={[0, 0.3, 0]}>
            <boxGeometry args={[0.3, 0.6, 0.3]} />
            <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
          </mesh>
        );
      case "b": // Bishop
        return (
          <group>
            <mesh position={[0, 0.3, 0]}>
              <cylinderGeometry args={[0.12, 0.22, 0.6, 8]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
            <mesh position={[0, 0.65, 0]}>
              <coneGeometry args={[0.12, 0.2, 8]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
          </group>
        );
      case "n": // Knight
        return (
          <group>
            <mesh position={[0, 0.25, 0]}>
              <cylinderGeometry args={[0.15, 0.22, 0.5, 8]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
            <mesh position={[0, 0.55, 0.1]} rotation={[0.3, 0, 0]}>
              <boxGeometry args={[0.2, 0.3, 0.15]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
          </group>
        );
      case "p": // Pawn
        return (
          <group>
            <mesh position={[0, 0.2, 0]}>
              <cylinderGeometry args={[0.12, 0.18, 0.4, 8]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
            <mesh position={[0, 0.45, 0]}>
              <sphereGeometry args={[0.1, 8, 8]} />
              <meshStandardMaterial color={pieceColor} emissive={emissive} emissiveIntensity={0.3} />
            </mesh>
          </group>
        );
      default:
        return null;
    }
  };

  return (
    <group
      position={position}
      onClick={onClick}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
      ref={meshRef}
    >
      {getPieceGeometry()}
    </group>
  );
}

function ChessBoard3D({ 
  game, 
  onSquareClick, 
  selectedSquare 
}: { 
  game: Chess; 
  onSquareClick: (square: Square) => void;
  selectedSquare: Square | null;
}) {
  const board = game.board();

  return (
    <group>
      {/* Board squares */}
      {Array.from({ length: 64 }).map((_, i) => {
        const row = Math.floor(i / 8);
        const col = i % 8;
        const isLight = (row + col) % 2 === 0;
        const x = (col - 3.5) * 1;
        const z = (row - 3.5) * 1;
        const squareName = `${"abcdefgh"[col]}${8 - row}` as Square;
        const isSelected = selectedSquare === squareName;

        return (
          <mesh
            key={i}
            position={[x, 0, z]}
            rotation={[-Math.PI / 2, 0, 0]}
            onClick={() => onSquareClick(squareName)}
          >
            <planeGeometry args={[0.95, 0.95]} />
            <meshStandardMaterial 
              color={isSelected ? "#4a9eff" : (isLight ? "#f0d9b5" : "#b58863")} 
              emissive={isSelected ? "#2266cc" : "#000000"}
              emissiveIntensity={isSelected ? 0.5 : 0}
            />
          </mesh>
        );
      })}

      {/* Chess pieces */}
      {board.map((row, rowIndex) =>
        row.map((square, colIndex) => {
          if (square) {
            const x = (colIndex - 3.5) * 1;
            const z = (rowIndex - 3.5) * 1;
            const squareName = `${"abcdefgh"[colIndex]}${8 - rowIndex}` as Square;
            
            return (
              <ChessPiece
                key={`${rowIndex}-${colIndex}`}
                position={[x, 0.05, z]}
                type={square.type}
                color={square.color === "w" ? "white" : "black"}
                onClick={() => onSquareClick(squareName)}
              />
            );
          }
          return null;
        })
      )}
    </group>
  );
}

export function ChessGame({ onFinish }: ChessGameProps) {
  const { t } = useLanguage();
  const [game, setGame] = useState(new Chess());
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);

  const makeMove = useCallback((from: Square, to: Square) => {
    try {
      const newGame = new Chess(game.fen());
      const move = newGame.move({
        from,
        to,
        promotion: "q",
      });

      if (move) {
        setGame(newGame);
        setMoveHistory(prev => [...prev, move.san]);
        setSelectedSquare(null);
        return true;
      }
    } catch (error) {
      console.log("Invalid move:", error);
    }
    return false;
  }, [game]);

  const onSquareClick = useCallback((square: Square) => {
    if (!selectedSquare) {
      const piece = game.get(square);
      if (piece && piece.color === game.turn()) {
        setSelectedSquare(square);
      }
    } else {
      if (selectedSquare === square) {
        setSelectedSquare(null);
      } else {
        const moved = makeMove(selectedSquare, square);
        if (!moved) {
          const piece = game.get(square);
          if (piece && piece.color === game.turn()) {
            setSelectedSquare(square);
          } else {
            setSelectedSquare(null);
          }
        }
      }
    }
  }, [selectedSquare, game, makeMove]);

  const handleResign = () => onFinish("loss");
  const handleOfferDraw = () => onFinish("draw");
  const handleClaimWin = () => onFinish("win");

  const resetGame = () => {
    const newGame = new Chess();
    setGame(newGame);
    setMoveHistory([]);
    setSelectedSquare(null);
  };

  const getGameStatus = () => {
    if (game.isCheckmate()) {
      const winner = game.turn() === "w" ? "Black" : "White";
      return `Checkmate! ${winner} wins!`;
    }
    if (game.isDraw()) return "Draw!";
    if (game.isStalemate()) return "Stalemate - Draw!";
    if (game.isThreefoldRepetition()) return "Draw by threefold repetition!";
    if (game.isInsufficientMaterial()) return "Draw by insufficient material!";
    if (game.isCheck()) return "Check!";
    return `${game.turn() === "w" ? "White" : "Black"} to move`;
  };

  return (
    <div className="w-full space-y-4">
      {/* Game Status */}
      <Card className="bg-card/50 border-white/10 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {game.isCheck() && <Crown className="h-5 w-5 text-yellow-500 animate-pulse" />}
            <span className="font-mono text-sm font-bold">
              {getGameStatus()}
            </span>
          </div>
          <div className="text-xs text-muted-foreground font-mono">
            {t("Move", "Move")} #{Math.floor(moveHistory.length / 2) + 1}
          </div>
        </div>
      </Card>

      {/* 3D Chess Board */}
      <div className="w-full aspect-square max-w-[500px] mx-auto rounded-lg overflow-hidden border-2 border-white/20 shadow-2xl bg-gradient-to-b from-slate-800 to-slate-900">
        <Canvas>
          <PerspectiveCamera makeDefault position={[0, 8, 8]} fov={50} />
          <OrbitControls 
            enablePan={false}
            minPolarAngle={Math.PI / 6}
            maxPolarAngle={Math.PI / 2.5}
            minDistance={6}
            maxDistance={12}
          />
          
          {/* Lighting */}
          <ambientLight intensity={0.5} />
          <directionalLight position={[5, 10, 5]} intensity={1} castShadow />
          <pointLight position={[-5, 5, -5]} intensity={0.5} />
          
          <ChessBoard3D 
            game={game} 
            onSquareClick={onSquareClick}
            selectedSquare={selectedSquare}
          />
        </Canvas>
      </div>

      {/* Move History */}
      {moveHistory.length > 0 && (
        <Card className="bg-card/50 border-white/10 p-3 max-h-32 overflow-y-auto">
          <div className="text-xs font-mono space-y-1">
            <div className="font-bold text-muted-foreground mb-2">
              {t("Move History", "Move History")}:
            </div>
            <div className="grid grid-cols-2 gap-x-4">
              {moveHistory.map((move, index) => (
                <div key={index} className="flex gap-2">
                  <span className="text-muted-foreground">
                    {index % 2 === 0 ? `${Math.floor(index / 2) + 1}.` : ""}
                  </span>
                  <span>{move}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Game Controls */}
      <div className="flex gap-2 flex-wrap justify-center">
        <Button
          onClick={resetGame}
          variant="outline"
          size="sm"
          className="text-xs"
        >
          {t("Reset Board", "Reset Board")}
        </Button>

        {game.isGameOver() && (
          <>
            {game.isCheckmate() && (
              <Button
                onClick={handleClaimWin}
                variant="default"
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-xs"
              >
                <Crown className="h-3 w-3 mr-1" />
                {t("Claim Victory", "Claim Victory")}
              </Button>
            )}
            {(game.isDraw() || game.isStalemate()) && (
              <Button
                onClick={handleOfferDraw}
                variant="default"
                size="sm"
                className="bg-yellow-600 hover:bg-yellow-700 text-xs"
              >
                {t("Accept Draw", "Accept Draw")}
              </Button>
            )}
          </>
        )}

        {!game.isGameOver() && (
          <>
            <Button
              onClick={handleOfferDraw}
              variant="outline"
              size="sm"
              className="text-xs"
            >
              {t("Offer Draw", "Offer Draw")}
            </Button>
            <Button
              onClick={handleResign}
              variant="destructive"
              size="sm"
              className="text-xs"
            >
              <Flag className="h-3 w-3 mr-1" />
              {t("Resign", "Resign")}
            </Button>
          </>
        )}
      </div>

      {/* Game Over Message */}
      {game.isGameOver() && (
        <Card className="bg-primary/10 border-primary/30 p-4 text-center">
          <p className="font-display font-bold text-lg text-primary">
            {game.isCheckmate() && t("Game Over - Checkmate!", "Game Over - Checkmate!")}
            {game.isDraw() && t("Game Over - Draw!", "Game Over - Draw!")}
            {game.isStalemate() && t("Game Over - Stalemate!", "Game Over - Stalemate!")}
          </p>
        </Card>
      )}
    </div>
  );
}
