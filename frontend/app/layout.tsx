import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "ShopMCP - Merchant Context Protocol",
  description: "Index your store, expose product context to MCP, and monitor indexing status."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>): JSX.Element {
  return (
    <html lang="en">
      <body>
        <main className="app-root">{children}</main>
      </body>
    </html>
  );
}
