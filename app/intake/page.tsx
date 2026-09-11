import IntakeForm from "@/components/IntakeForm";
import RecentBatches from "@/components/RecentBatches";

export default function IntakePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <IntakeForm />
      <RecentBatches />
    </main>
  );
}
