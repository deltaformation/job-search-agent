import Link from "next/link";
import Board from "@/components/board/Board";

export default function BoardPage() {
  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <p>
        <Link href="/" className="underline">
          Home
        </Link>{" "}
        ·{" "}
        <Link href="/intake" className="underline">
          Add job URLs
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold">Job board</h1>
      <p className="mt-1">
        Drag cards between columns, or open a card for the keyboard-operable
        move menu, notes, and full history.
      </p>
      <div className="mt-4">
        <Board />
      </div>
    </main>
  );
}
