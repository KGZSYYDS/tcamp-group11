import type { Metadata } from "next";
import "@fontsource-variable/manrope";
import ServiceWorkerBoot from "@/components/ServiceWorkerBoot";
import "./globals.css";
import "./styles/calendar.css";
import "./styles/workspace.css";

export const metadata: Metadata = {
  title: "深大日程助手",
  description: "课表、作业、考试、校园通知——与你有关的每一天",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <ServiceWorkerBoot />
      </body>
    </html>
  );
}
