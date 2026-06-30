import { useState } from "react";
import { api, pct, shortAddress, sol, time, usd } from "../api";
import { Empty, ErrorNotice, PageHeader, Status } from "../components";
import { useApi } from "../hooks";
import type { Position } from "../types";

export function PositionsPage() {
  const { data, error, refresh } = useApi<Position[]>("/api/positions", 10_000);
  const [actionError, setActionError] = useState<unknown>(null);
  async function sell(position: Position) {
    const address = position.token.address;
    if (!confirm(`确定卖出 ${position.token.symbol} 的全部剩余持仓？`)) return;
    try {
      await api(`/api/tokens/${address}/force-sell`, { method: "POST", headers: { "x-confirm-live": `SELL ${address}` } });
      await refresh();
    } catch (next) { setActionError(next); }
  }
  return <section className="page">
    <PageHeader eyebrow="资金敞口" title="持仓" description="成本、移动止盈与补仓状态都以真实成交为准。" />
    {Boolean(error || actionError) && <ErrorNotice error={error || actionError} />}
    <div className="position-list">
      {(data ?? []).map((position) => <article className="position-card" key={position.id}>
        <div className="position-head"><div><span className="token-symbol">{position.token.symbol}</span><code>{shortAddress(position.token.address)}</code></div><Status value={position.status}/></div>
        <div className="position-stats"><div><span>平均成本</span><strong>{usd(position.averageEntryPriceUsd)}</strong></div><div><span>投入</span><strong>{sol(position.totalSolIn)}</strong></div><div><span>已实现盈亏</span><strong className={Number(position.pnlPercent) >= 0 ? "positive" : "negative"}>{position.pnlPercent == null ? "持仓中" : pct(position.pnlPercent)}</strong></div><div><span>最高价</span><strong>{usd(position.highestPriceUsd)}</strong></div></div>
        <div className="position-flags"><span className={position.trailingActivated ? "flag active" : "flag"}>移动止盈 {position.trailingActivated ? "已激活" : "待激活"}</span><span className="flag">补仓 {position.addPositionCount}/1</span><span className="flag">实盘</span><span>入场 {time(position.entryTime)}</span></div>
        {position.status === "OPEN" && <button className="sell-button" onClick={() => void sell(position)}>全部卖出</button>}
      </article>)}
      {!data?.length && <Empty>还没有持仓记录。</Empty>}
    </div>
  </section>;
}
