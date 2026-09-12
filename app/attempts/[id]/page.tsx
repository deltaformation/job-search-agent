import Link from "next/link";
import { ArrowLeft, ChevronRight, Home } from "lucide-react";
import AttemptView from "@/components/AttemptView";

export default async function AttemptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-6">
      <div className="flex items-center justify-between border-b border-border/60 pb-4">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Link
            href="/"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <Home className="h-3 w-3" />
            <span>Home</span>
          </Link>
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
          <Link
            href="/intake"
            className="hover:text-foreground transition-colors"
          >
            Intake
          </Link>
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
          <span className="font-medium text-foreground">
            Attempt {id.length > 8 ? `${id.slice(0, 8)}...` : id}
          </span>
        </nav>

        <Link
          href="/intake"
          className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to intake</span>
        </Link>
      </div>

      <AttemptView workItemId={id} />
    </main>
  );
}
