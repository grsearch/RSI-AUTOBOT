# HELM · SOL RSI 自动交易机器人

一个面向 Solana 新币的纯实盘自动交易服务：接收代币 Webhook、保存 Birdeye 逐分钟行情、运行 RSI(7) 策略、真实链上成交、持仓恢复、回测、中文 Dashboard 与 systemd/Docker 部署。

## 这版对原方案做了哪些修正

1. **成交改用 Jupiter Swap V2 Meta-Aggregator。** Pump 新币可能仍在发射曲线，也可能已迁移到 PumpSwap；固定绑定 PumpSwap SDK 会出现“有流动性却无法成交”的盲区。Jupiter 会在当前可用路由间择优，执行前仍做买卖双向可成交检查。
2. **统一用 USD/Token 做策略判断。** 原方案把实际 `SOL/Token` 成本与 Birdeye `USD/Token` 价格直接比较，补仓和盈亏会算错。本实现用成交时 SOL/USD 换算实际 USD 成本；最终已实现盈亏仍按 SOL 结算。
3. **采用纯实盘执行。** 不包含 Paper 分支，也不设置每日亏损熔断、最大并发持仓或单币敞口限制。保留钱包手续费余额、铸币/冻结权限拦截、往返报价损耗上限和策略紧急止损。
4. **不盲目重发未知交易。** 实盘请求超时可能已经上链。机器人会留下 `PENDING/ERROR` 供人工核对，避免自动重试造成重复买入。
5. **只用已收盘 K 线计算 RSI。** 当前分钟的半根 K 线会持续变化，不参与信号判断。
6. **历史 FDV/LP 不回填污染。** 已保存 K 线的市场快照不会被后续轮询覆盖，回测不会偷看未来。

## 主要功能

- `POST /webhook/add-token`：密钥校验、Solana 地址验证、幂等添加
- Birdeye OHLCV、价格、FDV、流动性、链上创建时间持久化
- 首买、一次补仓、FDV/LP 强退、移动止盈、RSI 卖出、紧急止损
- 补仓仓位 50% + 剩余余额两批卖出；第二批实时读取钱包余额
- PostgreSQL + Prisma 状态恢复与完整交易审计
- Dashboard：总览、代币、持仓、成交、回测、暂停开关
- 回测记录、资金曲线与 CSV 导出
- Basic Auth、Webhook Secret、日志敏感字段脱敏
- Docker、systemd、Nginx、数据库备份脚本

## 本地启动

要求 Node.js 20+、pnpm、PostgreSQL 16+。

```bash
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm build
pnpm start
```

打开 `http://localhost:3001`，浏览器会要求输入 `.env` 中的 Dashboard 用户名和密码。

开发时可分别运行：

```bash
pnpm dev
pnpm dev:web
```

## 必填配置

服务只支持实盘，以下配置全部必填：

```env
BIRDEYE_API_KEY=...
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
JUPITER_API_KEY=...
JUPITER_API_PLAN=paid
WALLET_PRIVATE_KEY=base58_secret_key_or_json_byte_array
```

Jupiter 请求固定携带 `x-api-key`，不使用 keyless 或免费回退接口。`JUPITER_API_PLAN=paid` 是启动时的显式配置检查；实际订阅等级由 Jupiter Portal 中该 API Key 的计费套餐决定。

## Webhook 示例

```bash
curl -X POST http://localhost:3001/webhook/add-token \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-secret: your-secret' \
  -d '{"network":"solana","address":"MINT_ADDRESS","symbol":"TOKEN"}'
```

重复地址返回原记录，不会重复监控或首买。

## 实盘钱包

钱包配置：

```env
WALLET_PRIVATE_KEY=base58_secret_key_or_json_byte_array
JUPITER_API_KEY=...
JUPITER_API_PLAN=paid
```

私钥只从环境变量读取，日志会主动脱敏。生产环境更推荐外部密钥管理，而不是把私钥长期放在普通 `.env` 中。

## 风控语义

- Dashboard 的“暂停新买入”会阻止首买和补仓，但**不会停止已有持仓的安全卖出**。
- 不设置每日亏损熔断、最大持仓数或单币投入上限。
- `MAX_PRICE_IMPACT_PERCENT` 实际限制的是完整“买入再卖出”的报价损耗，比单一 price-impact 字段更保守。
- FDV/LP 跌破、紧急止损、移动止盈、RSI 的卖出优先级依次执行。
- 实盘手动卖出 API 还要求 `x-confirm-live: SELL <mint>`，防止误触。
- 每次 Jupiter 广播前都会保存 `requestId`、签名交易和可预计算哈希；异常重启后 Token 进入 `ERROR`，不会盲目重发。
- `POST /api/tokens/:address/reconcile` 会读取钱包真实余额；数据库余额不一致时必须提供已确认的 `txHash`，再恢复买入、补仓或卖出记录。

## API

除 `/healthz` 和 Webhook 外，所有 `/api/*` 都受 HTTP Basic Auth 保护。

- `GET/POST /api/tokens`
- `DELETE /api/tokens/:address`
- `POST /api/tokens/:address/force-sell`
- `POST /api/tokens/:address/reconcile`（仅用于人工核对未知实盘结果后解除 `ERROR`）
- `GET /api/positions`
- `GET /api/trades`
- `GET /api/overview`
- `GET /api/pnl/today`
- `GET /api/pnl/month`
- `GET /api/health`
- `GET/POST /api/settings`（运行时只允许暂停/恢复）
- `POST /api/backtest/run`
- `GET /api/backtest/runs`
- `GET /api/backtest/runs/:id`
- `GET /api/backtest/runs/:id/export.csv`

## 测试与验收

```bash
pnpm typecheck
pnpm test
pnpm build
```

上线前额外完成：

- 用专用小额钱包做一次首买、补仓、单批卖出、双批卖出
- 对比数据库成交数量与 Solscan 钱包余额变化
- 模拟服务在 `BUYING` / `SELLING` 中途重启
- 验证 Birdeye 429、Helius 超时和 Jupiter quote 失败都不会误买
- 验证备份可实际恢复，而不仅是生成文件

## 部署

systemd、Nginx 示例在 `deploy/`。安装后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sol-rsi-bot
journalctl -u sol-rsi-bot -f
```

Nginx 示例强制 HTTPS，并假设证书位于 `/etc/letsencrypt/live/bot.example.com/`。先替换域名并使用 Certbot 申请证书，Basic Auth 不得通过明文 HTTP 暴露。

每天 03:00 备份可加入 solbot 用户的 crontab：

```cron
0 3 * * * set -a; . /opt/sol-rsi-bot/.env; set +a; /opt/sol-rsi-bot/scripts/backup_db.sh
```

本软件会操作真实资金，不构成收益承诺。新币存在归零、撤池、冻结、税费/Token-2022 扩展和报价失效风险；任何自动风控都不能消除这些风险。
