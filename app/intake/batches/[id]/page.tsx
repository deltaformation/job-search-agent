import Link from "next/link";
import BatchProgress from "@/components/BatchProgress";

export default async function BatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <p className="mb-4 text-sm">
        <Link href="/intake" className="underline">
          Back to intake
        </Link>
      </p>
      <BatchProgress batchId={id} />
    </main>
  );
}
