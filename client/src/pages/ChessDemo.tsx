import { ChessGame } from "@/components/games/ChessGame";

export default function ChessDemo() {
  const handleFinish = (result: "win" | "loss" | "draw") => {
    console.log("Game finished with result:", result);
    alert(`Game finished: ${result}`);
  };

  return (
    <div className="min-h-screen bg-zinc-950 p-4">
      <div className="max-w-md mx-auto">
        <h1 className="text-xl font-bold text-white mb-4 text-center">Chess Demo</h1>
        <ChessGame onFinish={handleFinish} />
      </div>
    </div>
  );
}
