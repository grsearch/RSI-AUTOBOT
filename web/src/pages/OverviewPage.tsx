import { Activity, CircleDollarSign, Radar, ShieldCheck } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { sol } from "../api";
import { ErrorNotice, Metric, PageHeader } from "../components";
import { useApi } from "../hooks";
import type { Overview, PageResponse, Position } from "../types";

export function OverviewPage() {
  const { data, error } = useApi<Overview>("/api/overview", 10_000);
  const positions = useApi<PageResponse<"positions", Position> | Position[]>("/api/positions?status=CLOSED&page=1&pageSize=30", 20_000);
  const positionRows = Array.isArray(positions.data) ? positions.data : positions.data?.positions ?? [];
  const closed = positionRows.filter((item) => item.status === "CLOSED").slice(0, 30).reverse();
  let running = 0;
  const chart = closed.map((item) => ({ date: new Date(item.exitTime!).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }), pnl: running += Number(item.netPnlSol ?? 0) }));
  const healthy = data?.health?.schedulerRunning && data.health.birdeyeOk;
  return <section className="page">
    <PageHeader eyebrow="实时运行" title="交易总览" description="策略、仓位与系统健康，一眼看清。" />
    {Boolean(error) && <ErrorNotice error={error} />}
    <div className="metrics-grid">
      <Metric label="今日已实现盈亏" value={sol(data?.todayPnlSol)} tone={(data?.todayPnlSol ?? 0) >= 0 ? "good" : "bad"} hint="北京时间 00:00 起" />
      <Metric label="本月已实现盈亏" value={sol(data?.monthPnlSol)} tone={(data?.monthPnlSol ?? 0) >= 0 ? "good" : "bad"} />
      <Metric label="当前持仓" value={data?.openPositions ?? "—"} hint={`监控 ${data?.watchingCount ?? 0} 个代币`} />
      <Metric label="系统状态" value={healthy ? "运行正常" : "需要检查"} tone={healthy ? "good" : "bad"} hint={data?.health?.tradingPaused ? "交易已暂停" : "自动交易已开启"} />
    </div>
    <div className="dashboard-grid">
      <div className="card chart-card">
        <div className="card-title"><div><span>累计表现</span><h2>已实现盈亏曲线</h2></div><CircleDollarSign /></div>
        {chart.length ? <ResponsiveContainer width="100%" height={280}><AreaChart data={chart}><defs><linearGradient id="pnl" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#63e6be" stopOpacity={0.35}/><stop offset="100%" stopColor="#63e6be" stopOpacity={0}/></linearGradient></defs><XAxis dataKey="date" axisLine={false} tickLine={false} /><YAxis axisLine={false} tickLine={false} width={48}/><Tooltip contentStyle={{ background: "#10241c", border: "1px solid #28483a", borderRadius: 12 }}/><Area type="monotone" dataKey="pnl" stroke="#63e6be" fill="url(#pnl)" strokeWidth={2}/></AreaChart></ResponsiveContainer> : <div className="chart-placeholder">完成第一笔实盘交易后，这里会出现盈亏曲线。</div>}
      </div>
      <div className="card health-card">
        <div className="card-title"><div><span>服务探针</span><h2>系统健康</h2></div><ShieldCheck /></div>
        <HealthRow icon={<Radar />} label="Birdeye 行情" ok={data?.health?.birdeyeOk} />
        <HealthRow icon={<Activity />} label="策略调度器" ok={data?.health?.schedulerRunning} />
        <HealthRow icon={<ShieldCheck />} label="交易开关" ok={!data?.health?.tradingPaused} custom={data?.health?.tradingPaused ? "已暂停" : "已开启"} />
        <HealthRow icon={<ShieldCheck />} label="异常开放持仓" ok={(data?.health?.errorOpenPositionCount ?? 0) === 0} custom={(data?.health?.errorOpenPositionCount ?? 0) === 0 ? "无" : `${data?.health?.errorOpenPositionCount} 个需安全恢复/对账`} />
        {data?.health?.lastError && <p className="health-error">最近错误：{data.health.lastError}</p>}
      </div>
    </div>
  </section>;
}

function HealthRow({ icon, label, ok, custom }: { icon: React.ReactNode; label: string; ok?: boolean; custom?: string }) {
  return <div className="health-row"><span className="health-icon">{icon}</span><strong>{label}</strong><span className={ok ? "ok" : "not-ok"}>{custom ?? (ok ? "正常" : "未连接")}</span></div>;
}
