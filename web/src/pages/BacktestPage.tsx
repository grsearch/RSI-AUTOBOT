import { Download, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, pct, shortAddress, sol, time } from "../api";
import { Empty, ErrorNotice, Metric, PageHeader } from "../components";
import { useApi } from "../hooks";
import type { BacktestRun, PageResponse, Token } from "../types";

const initialParams = {
  buyAmountSol: 0.2,
  addAmountSol: 0.2,
  minFdvUsd: 30_000,
  minLiquidityUsd: 10_000,
  rsiBuyBelow: 25,
  rsiSellCrossDown: 99,
  trailingActivateProfitPercent: 30,
  trailingDrawdownPercent: 10,
  emergencyStopLossPercent: 0,
  slippagePercent: 6
};

export function BacktestPage() {
  const tokens = useApi<PageResponse<"tokens", Token>>("/api/tokens?page=1&pageSize=100");
  const runs = useApi<BacktestRun[]>("/api/backtest/runs");
  const [address, setAddress] = useState("");
  const [days, setDays] = useState(7);
  const [params, setParams] = useState(initialParams);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<BacktestRun | null>(null);

  const chart = useMemo(() => {
    let equity = 10;
    return (selected?.trades ?? []).map((trade) => ({
      date: new Date(String(trade.sellTime)).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }),
      equity: equity += Number(trade.pnlSol)
    }));
  }, [selected]);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - days * 86_400_000);
      const result = await api<BacktestRun>("/api/backtest/run", {
        method: "POST",
        body: JSON.stringify({ address, startTime, endTime, params })
      });
      setSelected(result);
      await runs.refresh();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }

  async function openRun(id: string) {
    try {
      setSelected(await api<BacktestRun>(`/api/backtest/runs/${id}`));
    } catch (next) {
      setError(next);
    }
  }

  const summary = selected?.summaryJson;
  return <section className="page">
    <PageHeader eyebrow="历史检验" title="策略回测" description="使用机器人已保存的 5 分钟行情验证策略，不把未来数据偷渡进过去。" />
    {Boolean(error) && <ErrorNotice error={error} />}
    <form className="backtest-form" onSubmit={run}>
      <label><span>代币</span><select required value={address} onChange={(event) => setAddress(event.target.value)}><option value="">选择已监控代币</option>{tokens.data?.tokens.map((token) => <option key={token.id} value={token.address}>{token.symbol} · {shortAddress(token.address)}</option>)}</select></label>
      <label><span>回测范围</span><select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>最近 1 天</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option></select></label>
      <button className="primary" disabled={busy}><Play size={17} />{busy ? "计算中" : "运行回测"}</button>
      <details className="advanced"><summary>调整策略参数</summary><div className="advanced-grid">{Object.entries(params).map(([key, value]) => <label key={key}><span>{paramLabel(key)}</span><input type="number" step="any" value={value} onChange={(event) => setParams((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>)}</div></details>
    </form>
    {summary && <>
      <div className="metrics-grid compact"><Metric label="已实现收益" value={sol(summary.totalPnlSol)} tone={Number(summary.totalPnlSol) >= 0 ? "good" : "bad"} /><Metric label="期末收益率" value={pct(summary.returnPercent)} /><Metric label="胜率" value={`${Number(summary.winRate).toFixed(1)}%`} hint={`${summary.totalTrades} 笔交易`} /><Metric label="最大回撤" value={`${Number(summary.maxDrawdownPercent).toFixed(2)}%`} tone="bad" /></div>
      <div className="card chart-card"><div className="card-title"><div><span>模拟资金</span><h2>已实现资金曲线</h2></div>{selected && <a className="secondary" href={`/api/backtest/runs/${selected.id}/export.csv`}><Download size={16} />导出 CSV</a>}</div>{chart.length ? <ResponsiveContainer width="100%" height={280}><AreaChart data={chart}><XAxis dataKey="date" /><YAxis /><Tooltip /><Area type="monotone" dataKey="equity" stroke="#63e6be" fill="#63e6be33" /></AreaChart></ResponsiveContainer> : <div className="chart-placeholder">该区间没有完成交易。</div>}</div>
    </>}
    <div className="card run-list"><div className="card-title"><div><span>历史记录</span><h2>已保存回测</h2></div></div>{runs.data?.map((run) => <button key={run.id} onClick={() => void openRun(run.id)}><div><strong>{run.name}</strong><span>{shortAddress(run.address)} · {time(run.createdAt)}</span></div><span className={Number(run.summaryJson.totalPnlSol) >= 0 ? "positive" : "negative"}>{sol(run.summaryJson.totalPnlSol)}</span></button>)}{!runs.data?.length && <Empty />}</div>
  </section>;
}

function paramLabel(key: string): string {
  const labels: Record<string, string> = {
    buyAmountSol: "首买 SOL",
    addAmountSol: "补仓 SOL",
    minFdvUsd: "最低 FDV",
    minLiquidityUsd: "最低流动性",
    rsiBuyBelow: "RSI 买入阈值",
    rsiSellCrossDown: "RSI 死叉线（99=关闭）",
    trailingActivateProfitPercent: "移动止盈激活 %",
    trailingDrawdownPercent: "最高价回撤 %",
    emergencyStopLossPercent: "紧急止损 %（0=关闭）",
    slippagePercent: "滑点 %"
  };
  return labels[key] ?? key;
}
