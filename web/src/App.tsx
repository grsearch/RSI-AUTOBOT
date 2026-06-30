import { Activity, BarChart3, Bot, Coins, FlaskConical, Gauge, Menu, Settings, X } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";

const OverviewPage = lazy(() => import("./pages/OverviewPage").then((module) => ({ default: module.OverviewPage })));
const TokensPage = lazy(() => import("./pages/TokensPage").then((module) => ({ default: module.TokensPage })));
const PositionsPage = lazy(() => import("./pages/PositionsPage").then((module) => ({ default: module.PositionsPage })));
const TradesPage = lazy(() => import("./pages/TradesPage").then((module) => ({ default: module.TradesPage })));
const BacktestPage = lazy(() => import("./pages/BacktestPage").then((module) => ({ default: module.BacktestPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

const nav = [
  ["/overview", "总览", Gauge],
  ["/tokens", "监控代币", Coins],
  ["/positions", "持仓", BarChart3],
  ["/trades", "成交记录", Activity],
  ["/backtest", "策略回测", FlaskConical],
  ["/settings", "安全与设置", Settings]
] as const;

export function App() {
  const [open, setOpen] = useState(false);
  return (
    <div className="shell">
      <aside className={open ? "sidebar open" : "sidebar"}>
        <div className="brand"><span className="brand-mark"><Bot size={20} /></span><div><strong>HELM</strong><small>SOL 交易控制台</small></div></div>
        <nav>
          {nav.map(([to, label, Icon]) => <NavLink key={to} to={to} onClick={() => setOpen(false)}><Icon size={18} />{label}</NavLink>)}
        </nav>
        <div className="sidebar-note"><span className="pulse" />策略服务已连接</div>
      </aside>
      {open && <button className="scrim" onClick={() => setOpen(false)} aria-label="关闭菜单" />}
      <main>
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button>
          <strong>HELM</strong>
        </header>
        <Suspense fallback={<div className="page loading">正在加载控制台…</div>}><Routes>
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/positions" element={<PositionsPage />} />
          <Route path="/trades" element={<TradesPage />} />
          <Route path="/backtest" element={<BacktestPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes></Suspense>
      </main>
    </div>
  );
}
