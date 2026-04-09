import type { Metadata } from "next";
import "./globals.css";
import { PrivyAppProvider } from "@/components/PrivyAppProvider";

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
        <PrivyAppProvider>{children}</PrivyAppProvider>
      </body>
    </html>
  );
}
