import type { Metadata } from "next";
import type { ReactNode } from "react";
import AppHeader from "@/components/AppHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Local Job Tracker",
  description: "Local-first job application tracker.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col bg-background text-foreground antialiased">
        <AppHeader />
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
