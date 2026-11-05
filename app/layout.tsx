import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Valo Shop",
  description: "Full-access Valorant smurf accounts",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
