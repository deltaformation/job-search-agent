const CURRENT_MILESTONE = "R1-A";
const PLATFORM_STACK = "Next.js + React + Tailwind on Node.js 24 LTS";

export default function PlatformStatus() {
  return (
    <section id="platform-status" aria-labelledby="platform-status-heading">
      <h1 id="platform-status-heading" className="text-3xl font-semibold">
        Local Job Tracker
      </h1>
      <p className="mt-4">
        Platform scaffold ({CURRENT_MILESTONE}): {PLATFORM_STACK}.
      </p>
      <p className="mt-2">
        URL intake, the board, and resume tailoring arrive in later milestones.
        Nothing here reads or writes product data yet.
      </p>
    </section>
  );
}
