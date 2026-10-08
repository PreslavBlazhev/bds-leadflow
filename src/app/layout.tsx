import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "BDS LeadFlow", template: "%s · BDS LeadFlow" },
  description: "Лична система за дневни бизнес контакти на Bulgaria Digital Services.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#08111F", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
