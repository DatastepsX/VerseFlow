import type { Metadata, Viewport } from "next";
import { ProfileTheme } from "@/components/ThemePicker";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VerseFlow",
  description: "Write lyrics and texts line by line, with rhyme-aware AI suggestions.",
  appleWebApp: { capable: true, title: "VerseFlow", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f3" },
    { media: "(prefers-color-scheme: dark)", color: "#111113" },
  ],
};

// the theme set in the app (More → Appearance) before the first paint; the status bar colour follows it
const THEME_SCRIPT = `try{var t=localStorage.getItem("verseflow.theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;document.addEventListener("DOMContentLoaded",function(){document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.content=t==="dark"?"#111113":"#f7f6f3"})})}}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ProfileTheme />
        {children}
      </body>
    </html>
  );
}
