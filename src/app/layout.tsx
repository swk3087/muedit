import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const bodyFont = Space_Grotesk({
  variable: "--font-body",
  subsets: ["latin"],
});

const monoFont = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "MUEdit | Web Audio Cut Room",
  description:
    "Browser-based music editor for cutting clips, arranging silence, shaping fades, and exporting lossless WAV.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className={`${bodyFont.variable} ${monoFont.variable}`}>
        {children}
      </body>
    </html>
  );
}
