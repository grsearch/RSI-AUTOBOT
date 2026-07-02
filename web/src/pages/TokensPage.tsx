import { ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, pct, shortAddress, time, usd } from "../api";
import { Empty, ErrorNotice, PageHeader, PaginationBar, Status } from "../components";
import { useApi } from "../hooks";
import type { PageResponse, Token } from "../types";

const PAGE_SIZE = 30;

export function TokensPage() {
  const [page, setPage] = useState(1);
  const { data, error, refresh } = useApi<PageResponse<"tokens", Token>>(`/api/tokens?page=${page}&pageSize=${PAGE_SIZE}`, 15_000);
  const [address, setAddress] = useState("");
  const [symbol, setSymbol] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setActionError(null);
    try {
      await api("/api/tokens", { method: "POST", body: JSON.stringify({ address, symbol }) });
      setAddress(""); setSymbol(""); setPage(1); await refresh();
    } catch (next) { setActionError(next); }
    finally { setBusy(false); }
  }

  async function remove(token: Token) {
    if (!confirm(`停止监控 ${token.symbol}？`)) return;
    try { await api(`/api/tokens/${token.address}`, { method: "DELETE" }); await refresh(); }
    catch (next) { setActionError(next); }
  }

  async function reconcile(token: Token) {
    const txHash = prompt("如果异常涉及已发送交易，请输入 Solana 交易签名；否则留空。")?.trim();
    if (txHash === undefined) return;
    const note = prompt("请输入本次人工核对说明（至少 5 个字符）。")?.trim();
    if (!note) return;
    try {
      await api(`/api/tokens/${token.address}/reconcile`, {
        method: "POST",
        headers: { "x-confirm-live": `RECONCILE ${token.address}` },
        body: JSON.stringify({ status: token.positions.length > 0 ? "HOLDING" : "WATCHING", note, txHash: txHash || undefined })
      });
      await refresh();
    } catch (next) { setActionError(next); }
  }

  return <section className="page">
    <PageHeader eyebrow="策略输入" title="监控代币" description="Webhook 推送与手动添加的代币会汇聚在这里。" />
    {Boolean(error || actionError) && <ErrorNotice error={error || actionError} />}
    <form className="add-token" onSubmit={add}>
      <label><span>代币地址</span><input required value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Solana mint address" /></label>
      <label><span>代号（可选）</span><input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="UNKNOWN" /></label>
      <button className="primary" disabled={busy}><Plus size={17}/>{busy ? "添加中" : "添加监控"}</button>
    </form>
    <div className="table-card"><div className="table-scroll"><table><thead><tr><th>代币</th><th>FDV</th><th>流动性</th><th>24h 成交量</th><th>RSI(7)</th><th>当前盈亏</th><th>状态</th><th>更新时间</th><th /></tr></thead><tbody>
      {(data?.tokens ?? []).map((token) => <tr key={token.id}><td><strong>{token.symbol}</strong><div className="subline"><a className="ca-link" href={token.gmgnUrl} target="_blank" rel="noreferrer"><code>{shortAddress(token.address)}</code><ExternalLink size={13}/></a></div></td><td>{usd(token.fdvUsd)}</td><td>{usd(token.liquidityUsd)}</td><td>{token.volume24hUsd == null ? "—" : usd(token.volume24hUsd)}</td><td className={Number(token.rsi) < 25 ? "accent" : ""}>{token.rsi == null ? "—" : Number(token.rsi).toFixed(1)}</td><td className={token.currentPnlPercent == null ? "" : Number(token.currentPnlPercent) >= 0 ? "positive" : "negative"}>{token.currentPnlPercent == null ? "—" : pct(token.currentPnlPercent)}</td><td><Status value={token.status}/></td><td>{time(token.lastMarketCheckAt)}</td><td>{token.status === "ERROR" && <button className="icon-button" onClick={() => void reconcile(token)} title="链上对账"><RefreshCw size={16}/></button>}<button className="icon-button danger" onClick={() => void remove(token)} disabled={token.positions.length > 0} title={token.positions.length ? "有持仓时不能移除" : "停止监控"}><Trash2 size={16}/></button></td></tr>)}
    </tbody></table></div>
      {!data?.tokens.length && <Empty>还没有监控代币。可在上方添加，或向 Webhook 推送。</Empty>}
      {data && <PaginationBar pagination={data.pagination} onPage={setPage} />}
    </div>
  </section>;
}
