import { Pause, Play, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { ErrorNotice, PageHeader } from "../components";
import { useApi } from "../hooks";
import type { Health, SettingsData } from "../types";

export function SettingsPage() {
  const settings = useApi<SettingsData>("/api/settings");
  const health = useApi<Health>("/api/health", 10_000);
  const [error, setError] = useState<unknown>(null);
  async function toggle() {
    try { await api("/api/settings", { method: "POST", body: JSON.stringify({ tradingPaused: !health.data?.tradingPaused }) }); await health.refresh(); } catch (next) { setError(next); }
  }
  const entries = settings.data ? Object.entries(settings.data).filter(([key]) => !["editableAtRuntime", "tradingMode", "tradingPaused"].includes(key)) : [];
  return <section className="page">
    <PageHeader eyebrow="交易控制" title="安全与设置" description="纯实盘运行；可随时暂停新的买入和补仓。" action={<span className="mode-badge live">实盘 · 付费 Jupiter API</span>} />
    {Boolean(settings.error || health.error || error) && (
      <ErrorNotice error={settings.error || health.error || error} />
    )}
    <div className="safety-panel"><span className="safety-icon"><ShieldAlert/></span><div><h2>{health.data?.tradingPaused ? "自动买入已暂停" : "自动交易正在运行"}</h2><p>暂停后不再首买或补仓，已有持仓的风控卖出仍继续执行。</p></div><button className={health.data?.tradingPaused ? "primary" : "stop-button"} onClick={() => void toggle()}>{health.data?.tradingPaused ? <><Play size={17}/>恢复交易</> : <><Pause size={17}/>暂停新买入</>}</button></div>
    <div className="card settings-card"><div className="card-title"><div><span>当前生效</span><h2>策略参数</h2></div></div><div className="settings-grid">{entries.map(([key, value]) => <div key={key}><span>{label(key)}</span><strong>{String(value)}</strong></div>)}</div><p className="settings-note">除交易暂停外，参数从服务器环境文件加载；修改后需重启服务，避免运行中途改变策略口径。</p></div>
  </section>;
}

function label(key: string): string {
  const map: Record<string, string> = { buyAmountSol: "首买 SOL", addPositionAmountSol: "补仓 SOL", slippagePercent: "最大滑点 %", minFdvUsd: "最低 FDV (USD)", minLiquidityUsd: "最低流动性 (USD)", minVolume24hUsd: "最低 24h 成交量 (USD)", rsiPeriod: "RSI 周期", rsiBuyBelow: "RSI 买入阈值", rsiSellCrossDown: "RSI 死叉线（99=关闭）", rsiSellAbove: "RSI 高位卖出", trailingActivateProfitPercent: "移动止盈激活 %", trailingDrawdownPercent: "最高价回撤 %", emergencyStopLossPercent: "紧急止损 %（0=关闭）" };
  return map[key] ?? key;
}
