import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "深大日历",
  description: "作业、签到、考试、体测——与你有关的每一天",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
