import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

export function Metric({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: string; tone?: "default" | "good" | "bad" }) {
  return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>;
}

export function Status({ value }: { value: string }) {
  const labels: Record<string, string> = { WATCHING: "监控中", BUYING: "买入中", HOLDING: "持仓中", SELLING: "卖出中", CLOSED: "已结束", REMOVED: "已移除", ERROR: "需处理", OPEN: "持仓中", CONFIRMED: "已确认", FAILED: "失败", PENDING: "确认中" };
  return <span className={`status status-${value.toLowerCase()}`}>{labels[value] ?? value}</span>;
}

export function Empty({ children = "这里还没有数据。" }: { children?: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNotice({ error }: { error: unknown }) {
  return <div className="notice error">{error instanceof Error ? error.message : String(error)}</div>;
}
