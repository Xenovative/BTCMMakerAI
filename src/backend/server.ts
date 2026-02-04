import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { MarketFetcher } from '../market-fetcher.js';
import { Trader } from '../trader.js';
import { Strategy } from '../strategy.js';
import { config } from '../config.js';
import { aiAnalyzer } from '../ai-analyzer.js';
import { llmAnalyzer } from '../llm-analyzer.js';
import { livePriceFeed } from './live-price-feed.js';
import { rtdsPriceFeed } from './rtds-price-feed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files in production
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Bot state
let botRunning = false;
let botInterval: NodeJS.Timeout | null = null;
let botStartTime: number | null = null;
const fetcher = new MarketFetcher();
const trader = new Trader();
const strategy = new Strategy();

// 購買鎖 - 防止同一市場重複購買
let buyingInProgress = false;
// Removed single-market lock to allow multiple concurrent markets

// Connected clients
const clients = new Set<WebSocket>();

// Broadcast to all clients
function broadcast(type: string, data: any) {
  const message = JSON.stringify({ type, data });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Helper to add delay between API calls
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Bot tick function
async function tick() {
  try {
    const state = await fetcher.getMarketState();
    await delay(500); // Rate limit protection

    if (!state) {
      console.log('[Tick] No market state');
      broadcast('market', null);
      return;
    }
    
    console.log(`[Tick] Up: ${state.upPrice.toFixed(1)}¢, Down: ${state.downPrice.toFixed(1)}¢, timeToStart: ${Math.round(state.timeToStart/1000)}s`);
    console.log('[Tick] Tokens next(up/down)=%s/%s current(up/down)=%s/%s', state.upTokenId, state.downTokenId, state.currentUpTokenId, state.currentDownTokenId);

    // Live price feed subscription
    const tokenIdsToSub: string[] = [];
    if (state.upTokenId) tokenIdsToSub.push(state.upTokenId);
    if (state.downTokenId) tokenIdsToSub.push(state.downTokenId);
    if (state.currentUpTokenId) tokenIdsToSub.push(state.currentUpTokenId);
    if (state.currentDownTokenId) tokenIdsToSub.push(state.currentDownTokenId);
    if (tokenIdsToSub.length > 0) {
      livePriceFeed.prune(tokenIdsToSub);
      livePriceFeed.subscribe(tokenIdsToSub);
    }

    // Apply live prices to state immediately if available (use cents)
    const liveSnapshot = livePriceFeed.getPricesFresh(10_000); // only use prices within 10s
    const liveAll = livePriceFeed.getPrices();
    const ageMap = livePriceFeed.getPriceAges();
    if (Object.keys(liveSnapshot).length === 0 && Object.keys(liveAll).length > 0) {
      console.log('[Tick][Prices] stale detected: have %d total but 0 fresh', Object.keys(liveAll).length);
    }
    const logPrice = (label: string, tokenId?: string) => {
      if (!tokenId) return 'n/a';
      const price = liveSnapshot[tokenId];
      const all = liveAll[tokenId];
      return `${label}=${price != null ? price.toFixed(4) : 'stale'} (raw=${all != null ? all.toFixed(4) : 'none'})`;
    };
    console.log('[Tick][Prices] fresh keys=%s %s %s %s %s',
      Object.keys(liveSnapshot).join(',') || 'none',
      logPrice('up', state.upTokenId),
      logPrice('down', state.downTokenId),
      logPrice('curUp', state.currentUpTokenId),
      logPrice('curDown', state.currentDownTokenId),
    );

    // Auto-resubscribe if any tracked token is stale
    const staleTokens = tokenIdsToSub.filter((t) => {
      const age = ageMap[t];
      return age !== undefined && age > 10_000; // older than 10s
    });
    if (staleTokens.length > 0) {
      console.warn('[Tick][Prices] stale tokens detected, pruning+resubscribing:', staleTokens.join(','));
      livePriceFeed.prune(tokenIdsToSub);
      livePriceFeed.subscribe(tokenIdsToSub);
      // Seed stale tokens with latest state prices to unblock
      const seedMap: Array<[string | undefined, number | undefined]> = [
        [state.upTokenId, state.upPrice],
        [state.downTokenId, state.downPrice],
        [state.currentUpTokenId, state.currentUpPrice],
        [state.currentDownTokenId, state.currentDownPrice],
      ];
      seedMap.forEach(([tid, price]) => {
        if (!tid || price == null) return;
        if (staleTokens.includes(tid)) {
          livePriceFeed.setPrice(tid, price, true);
        }
      });

      // If everything was stale (no fresh prices), force a WS reconnect
      if (Object.keys(liveSnapshot).length === 0) {
        console.warn('[Tick][Prices] forcing WS reconnect due to fully stale snapshot');
        livePriceFeed.forceReconnect();
      }
    }

    // Force reconnect if any tracked token age exceeds 15s even if snapshot not empty
    const maxAge = Math.max(...tokenIdsToSub.map((t) => ageMap[t] ?? 0), 0);
    if (maxAge > 15_000) {
      console.warn('[Tick][Prices] max age=%dms > 15000, forcing WS reconnect', maxAge);
      livePriceFeed.forceReconnect();
    }

    if (state.upTokenId && liveSnapshot[state.upTokenId] != null) state.upPrice = liveSnapshot[state.upTokenId];
    if (state.downTokenId && liveSnapshot[state.downTokenId] != null) state.downPrice = liveSnapshot[state.downTokenId];
    if (state.currentUpTokenId && liveSnapshot[state.currentUpTokenId] != null) state.currentUpPrice = liveSnapshot[state.currentUpTokenId];
    if (state.currentDownTokenId && liveSnapshot[state.currentDownTokenId] != null) state.currentDownPrice = liveSnapshot[state.currentDownTokenId];

    // Seed live feed with latest API prices only if not already present (avoid re-forcing 50/50)
    if (state.upTokenId) livePriceFeed.setPrice(state.upTokenId, state.upPrice, false);
    if (state.downTokenId) livePriceFeed.setPrice(state.downTokenId, state.downPrice, false);
    if (state.currentUpTokenId) livePriceFeed.setPrice(state.currentUpTokenId, state.currentUpPrice, false);
    if (state.currentDownTokenId) livePriceFeed.setPrice(state.currentDownTokenId, state.currentDownPrice, false);

    // Broadcast market state (prices will be updated after order book fetch)
    // Initial broadcast with API prices; will be updated below after order book mids computed
    let liveUp = state.upPrice;
    let liveDown = state.downPrice;
    let liveCurrentUp = state.currentUpPrice;
    let liveCurrentDown = state.currentDownPrice;

    // 從 API 同步持倉（只同步當前和下一個市場，避免 rate limit）
    await trader.syncPositionsFromApi(state.upTokenId, state.downTokenId, state.upPrice, state.downPrice);
    await delay(300);
    if (state.currentUpTokenId && state.currentDownTokenId) {
      await trader.syncPositionsFromApi(state.currentUpTokenId, state.currentDownTokenId, state.currentUpPrice, state.currentDownPrice);
      await delay(300);
    }

    // Update position prices
    const positions = trader.getPositions();
    strategy.updatePositionPrices(positions, state);

    // Fetch order books for AI analysis (if AI enabled)
    if (config.AI_ENABLED) {
      try {
        const currentEnabled = config.ALLOW_CURRENT_MARKET_TRADING && state.currentUpTokenId && state.currentDownTokenId;

        const [upOrderBook, downOrderBook, currentUpOrderBook, currentDownOrderBook] = await Promise.all([
          fetcher.getOrderBook(state.upTokenId),
          fetcher.getOrderBook(state.downTokenId),
          currentEnabled ? fetcher.getOrderBook(state.currentUpTokenId!) : Promise.resolve(null),
          currentEnabled ? fetcher.getOrderBook(state.currentDownTokenId!) : Promise.resolve(null),
        ]);
        await delay(300);
        
        // Normalize order book format
        const normalizeOrderBook = (ob: any) => ({
          bids: (ob?.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
          asks: (ob?.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
        });
        
        strategy.setOrderBooks(
          normalizeOrderBook(upOrderBook),
          normalizeOrderBook(downOrderBook),
          currentEnabled ? normalizeOrderBook(currentUpOrderBook) : undefined,
          currentEnabled ? normalizeOrderBook(currentDownOrderBook) : undefined,
        );

        // Compute mids from order books as fallback for live prices
        const getMid = (ob: any) => {
          const bid = ob?.bids?.[0]?.price;
          const ask = ob?.asks?.[0]?.price;
          if (bid == null || ask == null) return null;
          const bidNum = parseFloat(bid);
          const askNum = parseFloat(ask);
          const spreadCents = (askNum - bidNum) * 100;
          if (!isFinite(spreadCents) || spreadCents <= 0 || spreadCents > 20) return null; // ignore super wide books
          return ((bidNum + askNum) / 2) * 100;
        };
        const upMid = getMid(upOrderBook);
        const downMid = getMid(downOrderBook);
        console.log('[OrderBook Mids] Next: up=%.2f¢ down=%.2f¢ (from bids/asks in $)', upMid, downMid);
        // Use mids only when spread is sane; otherwise keep last/live
        if (upMid !== null && state.upTokenId) livePriceFeed.setPrice(state.upTokenId, upMid, true);
        if (downMid !== null && state.downTokenId) livePriceFeed.setPrice(state.downTokenId, downMid, true);
        if (currentEnabled) {
          const curUpMid = getMid(currentUpOrderBook);
          const curDownMid = getMid(currentDownOrderBook);
          console.log('[OrderBook Mids] Current: up=%.2f¢ down=%.2f¢', curUpMid, curDownMid);
          if (curUpMid !== null && state.currentUpTokenId) livePriceFeed.setPrice(state.currentUpTokenId, curUpMid, true);
          if (curDownMid !== null && state.currentDownTokenId) livePriceFeed.setPrice(state.currentDownTokenId, curDownMid, true);
        }

        // Refresh live prices after setting from order books
        const updatedLivePrices = livePriceFeed.getPrices();
        const priceKeys = Object.keys(updatedLivePrices);
        console.log('[Live Prices] Feed has %d prices. Looking for up=%s down=%s', 
          priceKeys.length, state.upTokenId, state.downTokenId);
        if (priceKeys.length > 0 && priceKeys.length < 10) {
          console.log('[Live Prices] Keys:', priceKeys.join(', '));
          console.log('[Live Prices] Values:', Object.values(updatedLivePrices).map(v => v.toFixed(2)).join(', '));
        }
        strategy.setLivePrices(updatedLivePrices);

        // Attach BTC spot (RTDS) for analyses
        const btcSpot = rtdsPriceFeed.getLatestPrice();
        strategy.setBtcSpot(btcSpot);

        // Update live price vars for broadcast
        const wsUp = updatedLivePrices[state.upTokenId];
        const wsDown = updatedLivePrices[state.downTokenId];
        const wsCurUp = state.currentUpTokenId ? updatedLivePrices[state.currentUpTokenId] : undefined;
        const wsCurDown = state.currentDownTokenId ? updatedLivePrices[state.currentDownTokenId] : undefined;

        // Prefer fresh WS; if missing, fall back to mids set earlier
        liveUp = wsUp ?? state.upPrice;
        liveDown = wsDown ?? state.downPrice;
        liveCurrentUp = wsCurUp ?? state.currentUpPrice;
        liveCurrentDown = wsCurDown ?? state.currentDownPrice;
        console.log('[Live Prices] Final broadcast: up=%.2f down=%.2f curUp=%.2f curDown=%.2f (wsUp=%s wsDown=%s)', 
          liveUp, liveDown, liveCurrentUp, liveCurrentDown,
          wsUp != null ? 'ws' : 'fallback', wsDown != null ? 'ws' : 'fallback');

        // Sanity: log if sum drifts too far from parity (advisory only)
        const sum = (liveUp || 0) + (liveDown || 0);
        if (sum < 90 || sum > 110) {
          console.warn('[Live Prices] parity warning sum=%.2f (up=%.2f down=%.2f)', sum, liveUp, liveDown);
        }

        // Pre-compute AI analyses for both scopes
        strategy.refreshAIAnalyses(state, positions);
        
        // Update AI analyzer with trade history for win rate calculation
        aiAnalyzer.updateTradeHistory(trader.getTradeHistory());
        
        // Trigger LLM analysis (non-blocking)
        if (config.LLM_ENABLED && llmAnalyzer.isAvailable()) {
          strategy.triggerLLMAnalysis(state, positions);
        }
      } catch (e) {
        console.log('[AI] Failed to fetch order books:', (e as Error).message);
      }
    }

    // Broadcast market state with live prices (after order book mids computed)
    broadcast('market', {
      currentMarket: state.currentMarket?.question || null,
      nextMarket: state.nextMarket?.question || null,
      upPrice: liveUp,
      downPrice: liveDown,
      currentUpPrice: liveCurrentUp,
      currentDownPrice: liveCurrentDown,
      timeToStart: state.timeToStart,
      timeToEnd: state.timeToEnd,
      btcSpot: rtdsPriceFeed.getLatestPrice(),
      uptimeSeconds: botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
    });
    console.log('[Market broadcast] up=%d down=%d curUp=%d curDown=%d', liveUp, liveDown, liveCurrentUp, liveCurrentDown);

    // Broadcast positions (with market name)
    const tokenToMarket = new Map<string, string>();
    for (const mkt of state.allMarkets || []) {
      for (const t of mkt.tokens || []) {
        if (t?.tokenId) tokenToMarket.set(t.tokenId, mkt.question || mkt.slug || '');
      }
    }

    const positionsArray = Array.from(positions.values())
      .filter((pos) => pos.size >= 0.1)
      .map((pos) => {
        const marketName = tokenToMarket.get(pos.tokenId) || state.currentMarket?.question || state.nextMarket?.question || '';
        const returnPct = pos.avgBuyPrice > 0 ? (pos.currentPrice - pos.avgBuyPrice) / pos.avgBuyPrice : 0;
        const returnUsd = ((pos.currentPrice - pos.avgBuyPrice) * pos.size) / 100;
        return {
          tokenId: pos.tokenId,
          outcome: pos.outcome,
          size: pos.size,
          avgBuyPrice: pos.avgBuyPrice,
          currentPrice: pos.currentPrice,
          unrealizedPnl: (pos.currentPrice - pos.avgBuyPrice) * pos.size,
          returnPct,
          returnUsd,
          market: marketName,
        };
      });
    broadcast('positions', positionsArray);

    // 當前市場 ID（僅供日誌使用）
    const marketId = state.nextMarket?.conditionId || state.currentMarket?.conditionId || '';

    // 檢查現有持倉是否需要補掛 Limit Sell 或清理剩餘
    for (const [tokenId, pos] of positions) {
      if (pos.size > 0 && !config.PAPER_TRADING) {
        // 先嘗試補掛 Limit Sell
        await trader.placeLimitSellForPosition(tokenId, pos.outcome, pos.avgBuyPrice, pos.currentPrice);
        await delay(300);
        // 清理極小剩餘（< 0.5 股），避免誤清倉
        if (pos.size < 0.5) {
          await trader.marketSellRemainder(tokenId, pos.outcome, pos.currentPrice, 'tiny_remainder');
          await delay(300);
        }
      }
    }

    // Ensure live prices are warm/fresh before trading
    const warmMaxAge = 15_000; // default 15s freshness
    const endgameTightAge = 5_000; // tighten near market end
    const isNearEnd = state.currentMarket && state.timeToEnd > 0 && state.timeToEnd <= config.SELL_BEFORE_START_MS + 30_000; // within clear-out window + 30s
    const freshnessLimit = isNearEnd ? endgameTightAge : warmMaxAge;

    const requiredTokens = [state.upTokenId, state.downTokenId].filter(Boolean) as string[];
    const staleForTrade = requiredTokens.filter((t) => {
      const age = ageMap[t];
      return age === undefined || age > freshnessLimit;
    });
    if (staleForTrade.length > 0) {
      console.warn('[Trade] prices not warm for', staleForTrade.join(','), `limit=${freshnessLimit}ms`, 'isNearEnd=', isNearEnd, '-> trigger loss exits if any');

      // Even with stale prices, protect downside: force loss exits using last known prices
      for (const [tokenId, pos] of positions) {
        if (pos.size <= 0) continue;
        const loss = pos.avgBuyPrice - pos.currentPrice;
        if (loss >= config.STOP_LOSS) {
          console.warn(`[StalePrice LossExit] ${pos.outcome} loss=${loss.toFixed(2)}¢ >= stopLoss=${config.STOP_LOSS}¢, force market sell`);
          await trader.forceLiquidate(tokenId, pos.outcome, pos.currentPrice);
          await delay(300);
        }
      }
      return;
    }

    // Generate and execute signals
    const signals = strategy.generateSignals(state, positions);

    for (const signal of signals) {
      console.log(`📍 Signal: ${signal.action} ${signal.outcome} - ${signal.reason}`);

      let success = false;
      if (signal.action === 'BUY') {
        // 防止重複購買: 檢查鎖和市場 ID
        if (buyingInProgress) {
          console.log(`[跳過] 購買中，等待上一筆完成`);
          continue;
        }
        buyingInProgress = true;
        try {
          success = await trader.buy(signal.tokenId, signal.outcome, signal.price, signal.size);
        } finally {
          buyingInProgress = false;
        }
      } else if (signal.action === 'SELL') {
        // 檢查是否是強制清倉（開局前）
        if (signal.reason?.includes('開局清倉')) {
          success = await trader.forceLiquidate(signal.tokenId, signal.outcome, signal.price);
        } else {
          success = await trader.sell(signal.tokenId, signal.outcome, signal.price, signal.size, signal.reason || 'signal');
        }
      }

      await delay(500); // Rate limit between trades
      if (success) {
        // Broadcast trade using the most recent executed record from trader history (captures actual fill price/size)
        const tradeMarket = tokenToMarket.get(signal.tokenId) || state.nextMarket?.question || state.currentMarket?.question || 'Unknown';
        const history = trader.getTradeHistory();
        const last = history[history.length - 1];
        broadcast('trade', {
          id: Date.now().toString(),
          timestamp: last?.timestamp ? new Date(last.timestamp).getTime() : Date.now(),
          market: tradeMarket,
          outcome: last?.outcome || signal.outcome,
          side: last?.side || signal.action,
          price: last?.price != null ? last.price : signal.price,
          size: last?.size != null ? last.size : signal.size,
          pnl: last?.pnl,
        });
      }
    }

    // Broadcast PnL stats
    const history = trader.getTradeHistory();
    const sells = history.filter((t) => t.side === 'SELL');
    const totalPnl = sells.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalCost = sells.reduce((sum, t) => sum + (t.costCents || 0), 0);
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const wins = sells.filter((t) => (t.pnl || 0) > 0).length;
    const totalTrades = sells.length;

    broadcast('pnl', {
      totalPnl,
      totalTrades,
      totalCost,
      totalPnlPct,
      winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    });

    // Update loss streak cooldowns
    const computeLossState = () => {
      const now = Date.now();
      const state: Record<'Up' | 'Down', { streak: number; cooldownUntil: number }> = {
        Up: { streak: 0, cooldownUntil: 0 },
        Down: { streak: 0, cooldownUntil: 0 },
      };
      history
        .filter((t) => t.side === 'SELL' && (t.pnl !== undefined))
        .forEach((t) => {
          const outcome = t.outcome as 'Up' | 'Down';
          const ts = typeof t.timestamp === 'number' ? t.timestamp : new Date(t.timestamp as any).getTime();
          if ((t.pnl || 0) < 0) {
            state[outcome].streak += 1;
          } else {
            state[outcome].streak = 0;
          }
          if (state[outcome].streak >= config.LOSS_STREAK_THRESHOLD) {
            state[outcome].cooldownUntil = Math.max(state[outcome].cooldownUntil, ts + config.LOSS_STREAK_COOLDOWN_MS);
          }
        });
      // Ensure cooldown times are in the future relative to now
      (['Up', 'Down'] as const).forEach((o) => {
        if (state[o].cooldownUntil < now) state[o].cooldownUntil = 0;
      });
      return state;
    };
    const lossState = computeLossState();
    strategy.setLossStreaks(lossState);

    broadcast('cooldown', lossState);

    // Broadcast recent trades (last 200) with numeric timestamps for charts
    const recentTrades = history.slice(-200).map((t) => ({
      ...t,
      timestamp: typeof t.timestamp === 'number' ? t.timestamp : new Date(t.timestamp).getTime(),
      pnl: t.pnl ?? 0,
    }));
    broadcast('trades', recentTrades);

    // Hard stop if loss limit breached
    if (config.LOSS_LIMIT_CENTS > 0 && totalPnl <= -Math.abs(config.LOSS_LIMIT_CENTS)) {
      console.warn(`[Risk] Total PnL ${totalPnl.toFixed(2)}¢ <= -${config.LOSS_LIMIT_CENTS}¢, stopping bot.`);
      stopBot();
      return;
    }

    // Broadcast AI analysis (next + current)
    if (config.AI_ENABLED) {
      const scopes: Array<'next' | 'current'> = ['next', 'current'];
      for (const scope of scopes) {
        const aiAnalysis = strategy.getLastAIAnalysis(scope);
        if (aiAnalysis) {
          broadcast('ai_analysis', {
            scope,
            shouldTrade: aiAnalysis.shouldTrade,
            recommendedOutcome: aiAnalysis.recommendedOutcome,
            confidence: aiAnalysis.confidence,
            recommendedSize: aiAnalysis.recommendedSize,
            reasons: aiAnalysis.reasons,
            signals: {
              technical: aiAnalysis.signals.technical.score,
              orderBook: aiAnalysis.signals.orderBook.score,
              sentiment: aiAnalysis.signals.sentiment.score,
              timing: aiAnalysis.signals.timing.score,
            },
          });
        }
      }
    }

    // Broadcast LLM analysis (next + current)
    if (config.LLM_ENABLED) {
      const scopes: Array<'next' | 'current'> = ['next', 'current'];
      for (const scope of scopes) {
        const llmAnalysis = strategy.getLastLLMAnalysis(scope);
        if (llmAnalysis) {
          broadcast('llm_analysis', {
            scope,
            shouldTrade: llmAnalysis.shouldTrade,
            recommendedOutcome: llmAnalysis.recommendedOutcome,
            confidence: llmAnalysis.confidence,
            recommendedSize: llmAnalysis.recommendedSize,
            reasoning: llmAnalysis.reasoning,
            marketSummary: llmAnalysis.marketSummary,
          });
        }
      }
    }
  } catch (error) {
    console.error('[Bot] Tick error:', error);
  }
}

// Start bot
async function startBot() {
  if (botRunning) return;

  console.log('🚀 Starting bot...');
  botRunning = true;
  botStartTime = Date.now();
  trader.reset();
  // Connect live price feed
  try {
    livePriceFeed.connect();
  } catch (e) {
    console.warn('[WS] Failed to start price feed', e);
  }

  // Connect RTDS BTC spot feed
  if (config.RTDS_ENABLED) {
    try {
      rtdsPriceFeed.connect();
    } catch (e) {
      console.warn('[RTDS] Failed to start spot feed', e);
    }
  }

  await tick(); // Initial tick
  botInterval = setInterval(tick, config.POLL_INTERVAL_MS);

  // Sync server time
  await fetcher.syncServerTime();

  // Initialize trader
  const initialized = await trader.initialize();
  if (!initialized && !config.PAPER_TRADING) {
    console.error('❌ Failed to initialize trader');
    return;
  }

  botRunning = true;

  broadcast('status', {
    running: true,
    connected: true,
    paperTrade: config.PAPER_TRADING,
    uptimeSeconds: botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
  });

  console.log('✅ Bot started');
}

// Stop bot
function stopBot() {
  if (!botRunning) return;

  console.log('🛑 Stopping bot...');

  if (botInterval) {
    clearInterval(botInterval);
    botInterval = null;
  }

  botRunning = false;
  botStartTime = null;
  trader.reset();

  broadcast('status', {
    running: false,
    connected: true,
    paperTrade: config.PAPER_TRADING,
    uptimeSeconds: botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
  });

  console.log('✅ Bot stopped');
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  clients.add(ws);

  // Send initial state
  ws.send(
    JSON.stringify({
      type: 'status',
      data: {
        running: botRunning,
        connected: true,
        paperTrade: config.PAPER_TRADING,
        totalPnl: 0,
        totalTrades: 0,
        winRate: 0,
      },
    })
  );

  ws.send(
    JSON.stringify({
      type: 'config',
      data: {
        paperTrade: config.PAPER_TRADING,
        maxBuyPrice: config.MAX_BUY_PRICE,
        priceFloor: config.PRICE_FLOOR,
        priceCeiling: config.PRICE_CEILING,
        profitTarget: config.PROFIT_TARGET,
        profitTargetPct: config.PROFIT_TARGET_PCT,
        stopLoss: config.STOP_LOSS,
        stopLossPct: config.STOP_LOSS_PCT,
        combinedPriceCap: config.COMBINED_PRICE_CAP,
        maxPositionSize: config.MAX_POSITION_SIZE,
        allowCurrentMarketTrading: config.ALLOW_CURRENT_MARKET_TRADING,
        privateKey: '',
        funderAddress: config.FUNDER_ADDRESS,
      },
    })
  );

  // Handle messages
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      const { type, data: payload } = message;

      switch (type) {
        case 'start':
          await startBot();
          break;
        case 'stop':
          stopBot();
          break;
        case 'config':
          // Update config (in memory only for security)
          if (payload.privateKey) {
            (config as any).PRIVATE_KEY = payload.privateKey;
          }
          if (payload.funderAddress) {
            (config as any).FUNDER_ADDRESS = payload.funderAddress;
          }
          if (payload.paperTrade !== undefined) {
            (config as any).PAPER_TRADING = payload.paperTrade;
          }
          if (payload.maxBuyPrice) {
            (config as any).MAX_BUY_PRICE = payload.maxBuyPrice;
          }
          if (payload.priceFloor) {
            (config as any).PRICE_FLOOR = payload.priceFloor;
          }
          if (payload.priceCeiling) {
            (config as any).PRICE_CEILING = payload.priceCeiling;
          }
          if (payload.profitTarget) {
            (config as any).PROFIT_TARGET = payload.profitTarget;
          }
          if (payload.profitTargetPct) {
            (config as any).PROFIT_TARGET_PCT = payload.profitTargetPct;
          }
          if (payload.maxPositionSize) {
            (config as any).MAX_POSITION_SIZE = payload.maxPositionSize;
          }
          if (payload.stopLoss) {
            (config as any).STOP_LOSS = payload.stopLoss;
          }
          if (payload.stopLossPct) {
            (config as any).STOP_LOSS_PCT = payload.stopLossPct;
          }
          if (payload.combinedPriceCap) {
            (config as any).COMBINED_PRICE_CAP = payload.combinedPriceCap;
          }
          if (payload.allowCurrentMarketTrading !== undefined) {
            (config as any).ALLOW_CURRENT_MARKET_TRADING = payload.allowCurrentMarketTrading;
          }

          broadcast('status', {
            running: botRunning,
            connected: true,
            paperTrade: config.PAPER_TRADING,
          });

          console.log('[Config] Updated');
          break;
      }
    } catch (error) {
      console.error('[WS] Message error:', error);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    clients.delete(ws);
  });
});

// API routes
app.get('/api/status', (req, res) => {
  res.json({
    running: botRunning,
    paperTrade: config.PAPER_TRADING,
  });
});

app.post('/api/start', async (req, res) => {
  await startBot();
  res.json({ running: botRunning });
});

app.post('/api/stop', (req, res) => {
  stopBot();
  res.json({ running: botRunning });
});

app.post('/api/config', (req, res) => {
  const payload = req.body;
  if (payload.privateKey) {
    (config as any).PRIVATE_KEY = payload.privateKey;
  }
  if (payload.funderAddress) {
    (config as any).FUNDER_ADDRESS = payload.funderAddress;
  }
  if (payload.paperTrade !== undefined) {
    (config as any).PAPER_TRADING = payload.paperTrade;
  }
  if (payload.maxBuyPrice) {
    (config as any).MAX_BUY_PRICE = payload.maxBuyPrice;
  }
  console.log('[Config] Updated via API:', { paperTrade: config.PAPER_TRADING });
  res.json({ success: true, paperTrade: config.PAPER_TRADING });
});

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Start server
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🚀 BTC 15M TRADING BOT SERVER                              ║
║                                                              ║
║   Backend:   http://localhost:${PORT}                          ║
║   WebSocket: ws://localhost:${PORT}/ws                         ║
║                                                              ║
║   Frontend:  Run 'npm run dev:frontend' to start             ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
