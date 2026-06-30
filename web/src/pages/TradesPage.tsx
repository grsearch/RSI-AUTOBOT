import { ExternalLink } from "lucide-react";
import { shortAddress, sol, time, usd } from "../api";
import { Empty, ErrorNotice, PageHeader, Status } from "../components";
import { useApi } from "../hooks";
import type { Trade } from "../types";

const sideLabel: Record<string, string> = { BUY_INITIAL: "首买", BUY_ADD: "补仓", SELL: "卖出" };

export function TradesPage() {
  const { data, error } = useApi<Trade[]>("/api/trades?limit=500", 15_000);
  return <section className="page">
    <PageHeader eyebrow="审计轨迹" title="成交记录" description="每一笔报价、成交、批次与失败原因都留有记录。" />
    {Boolean(error) && <ErrorNotice error={error} />}
    <div className="table-card"><div className="table-scroll"><table><thead><tr><th>时间</th><th>代币</th><th>方向</th><th>金额</th><th>成交价</th><th>交易时行情</th><th>原因</th><th>状态</th><th>链上</th></tr></thead><tbody>
      {(data ?? []).map((trade) => <tr key={trade.id}><td>{time(trade.createdAt)}</td><td><strong>{trade.token.symbol}</strong><div><code>{shortAddress(trade.token.address)}</code></div></td><td><span className={`side side-${trade.side.toLowerCase()}`}>{sideLabel[trade.side]}{trade.batchNumber ? ` · ${trade.batchNumber}` : ""}</span></td><td>{sol(trade.amountSol)}<div className="subline">{Number(trade.amountToken).toLocaleString()} token</div></td><td>{usd(trade.priceUsd)}</td><td><span>FDV {usd(trade.fdvAtTradeUsd)}</span><div className="subline">LP {usd(trade.liquidityAtTradeUsd)} · RSI {trade.rsiAtTrade == null ? "—" : Number(trade.rsiAtTrade).toFixed(1)}</div></td><td title={trade.errorMessage}>{trade.reason}</td><td><Status value={trade.status}/></td><td>{trade.txHash ? <a href={`https://solscan.io/tx/${trade.txHash}`} target="_blank" rel="noreferrer"><ExternalLink size={16}/></a> : "—"}</td></tr>)}
    </tbody></table></div>{!data?.length && <Empty>还没有成交记录。</Empty>}</div>
  </section>;
}
