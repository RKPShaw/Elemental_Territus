import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://elemental-frontiers.shawp.chatgpt.site"),
  title: "Elemental Frontiers",
  description:
    "Watch five autonomous elemental empires trade in peace, declare wars, commit troops and press living frontiers across land and sea.",
  openGraph: {
    title: "Elemental Frontiers",
    description: "Peace, prosperity and pressure-front conquest in a tiny living world.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Five cute elemental kingdoms meeting on a colorful fantasy world map.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Elemental Frontiers",
    description: "Peace, prosperity and pressure-front conquest in a tiny living world.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
