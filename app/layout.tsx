import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Axiem",
  description: "A pause-first behavioural intelligence system for discretionary traders.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Instrument Sans: clean neutral grotesque — Swiss editorial quality */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ fontFamily: "'Instrument Sans', system-ui, -apple-system, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
