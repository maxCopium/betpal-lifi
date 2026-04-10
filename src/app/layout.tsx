import type { Metadata } from "next";
import "./globals.css";
import { PrivyAppProvider } from "@/components/PrivyAppProvider";
import { AppShell } from "@/components/win98/AppShell";

export const metadata: Metadata = {
  title: "BetPal",
  description:
    "Bet with friends on Polymarket outcomes. Stakes earn yield in a shared group vault. Zero house edge.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <PrivyAppProvider>
          <AppShell>{children}</AppShell>
        </PrivyAppProvider>
      </body>
    </html>
  );
}
