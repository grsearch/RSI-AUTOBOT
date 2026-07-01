import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { api, pct, shortAddress, sol, time, usd } from "../api";
import { Empty, ErrorNotice, PageHeader, PaginationBar, Status } from "../components";
import { useApi } from "../hooks";
import type { PageResponse, Position } from "../types";

const PAGE_SIZE = 30;

export function PositionsPage() {
  const [page, setPage] = useState(1);
  const { data, error, refresh } = useApi<PageResponse<"positions", Position>>(`/api/positions?page=${page}&pageSize=${PAGE_SIZE}`, 10_000);
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
    <PageHeader eyebrow="资金敞口" title="持仓" description="成本、实时盈亏、移动止盈与补仓状态都以真实成交为准。" />
    {Boolean(error || actionError) && <ErrorNotice error={error || actionError} />}
    <div className="table-card">
      <div className="table-scroll"><table><thead><tr><th>代币</th><th>状态</th><th>入场时间</th><th>平均成本</th><th>当前价</th><th>投入</th><th>盈亏</th><th>最高价</th><th>策略状态</th><th /></tr></thead><tbody>
        {(data?.positions ?? []).map((position) => {
          const pnl = currentPnl(position);
          return <tr key={position.id}>
            <td><strong>{position.token.symbol}</strong><div className="subline"><a className="ca-link" href={position.token.gmgnUrl} target="_blank" rel="noreferrer"><code>{shortAddress(position.token.address)}</code><ExternalLink size={12} /></a></div></td>
            <td><Status value={position.status} /></td>
            <td>{time(position.entryTime)}</td>
            <td>{usd(position.averageEntryPriceUsd)}</td>
            <td>{position.token.priceUsd == null ? "—" : usd(position.token.priceUsd)}</td>
            <td>{sol(position.totalSolIn)}</td>
            <td className={pnl == null ? "" : pnl >= 0 ? "positive" : "negative"}>{pnl == null ? "—" : pct(pnl)}</td>
            <td>{usd(position.highestPriceUsd)}</td>
            <td><span className={position.trailingActivated ? "flag active" : "flag"}>移动止盈 {position.trailingActivated ? "已激活" : "待激活"}</span><div className="subline">补仓 {position.addPositionCount}/1</div></td>
            <td>{position.status === "OPEN" && <button className="stop-button compact" onClick={() => void sell(position)}>全部卖出</button>}</td>
          </tr>;
        })}
      </tbody></table></div>
      {!data?.positions.length && <Empty>还没有持仓记录。</Empty>}
      {data && <PaginationBar pagination={data.pagination} onPage={setPage} />}
    </div>
  </section>;
}

function currentPnl(position: Position): number | null {
  if (position.status !== "OPEN") return position.pnlPercent == null ? null : Number(position.pnlPercent);
  const current = Number(position.token.priceUsd);
  const average = Number(position.averageEntryPriceUsd);
  return current > 0 && average > 0 ? ((current - average) / average) * 100 : null;
}
