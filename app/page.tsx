import Link from "next/link";
import PlatformStatus from "@/components/PlatformStatus";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <a
        href="#platform-status"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-white focus:px-3 focus:py-2 focus:underline"
      >
        Skip to platform status
      </a>
      <PlatformStatus />
      <nav aria-label="Product" className="mt-6">
        <Link href="/intake" className="underline">
          Add job URLs
        </Link>
      </nav>
    </main>
  );
}
