"use client";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p role="alert" className="mt-3">
        {error.message || "The page failed to load."}
      </p>
      {error.digest !== undefined && error.digest !== "" ? (
        <p className="mt-2 text-sm">Reference: {error.digest}</p>
      ) : null}
      <button
        type="button"
        onClick={() => reset()}
        className="mt-6 underline underline-offset-4"
      >
        Try again
      </button>
    </main>
  );
}
