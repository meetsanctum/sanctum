import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "./globals.css";

import favicon from "@meetsanctum/brand/sanctum-favicon.svg";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

// The product name is defined once, in the client; the site shares it.
import { productName } from "../../../client/src/brand";
import { siteUrl } from "../site";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: `${productName} · A smart home for everyone`,
  description: `${productName} is free, open source home automation that runs your lights, sensors and automations on a small computer in your home. It needs no internet, and your data stays local.`,
  icons: { icon: favicon.src },
};

export const viewport: Viewport = {
  themeColor: "#222326",
};

export default function Layout(props: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  );
}
