import AttemptView from "@/components/AttemptView";

export default async function AttemptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <AttemptView workItemId={id} />
    </main>
  );
}
