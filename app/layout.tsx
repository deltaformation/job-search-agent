import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Outfit, Geist_Mono } from "next/font/google";
import AppHeader from "@/components/AppHeader";
import PageTransition from "@/components/PageTransition";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Local Job Tracker",
  description: "Local-first job application tracker.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`h-full ${outfit.variable} ${geistMono.variable}`}>
      <body className="min-h-full flex flex-col bg-background text-foreground antialiased font-sans">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:ring-2 focus:ring-ring focus:shadow-md"
        >
          Skip to main content
        </a>
        <AppHeader />
        <div className="flex-1">
          <PageTransition>{children}</PageTransition>
        </div>
      </body>
    </html>
  );
}
