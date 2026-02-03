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
    const liveSnapshot = livePriceFeed.getPricesFresh(30_000); // only use prices within 30s
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
      return age !== undefined && age > 30_000; // older than 30s
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

        // Prefer WS, then API price, lastly mid (only if both sides existed)
        liveUp = wsUp ?? state.upPrice ?? upMid;
        liveDown = wsDown ?? state.downPrice ?? downMid;
        liveCurrentUp = state.currentUpTokenId ? (wsCurUp ?? state.currentUpPrice ?? (currentEnabled ? getMid(currentUpOrderBook) : null)) : state.currentUpPrice;
        liveCurrentDown = state.currentDownTokenId ? (wsCurDown ?? state.currentDownPrice ?? (currentEnabled ? getMid(currentDownOrderBook) : null)) : state.currentDownPrice;
        console.log('[Live Prices] Final broadcast: up=%.2f down=%.2f (source up=%s down=%s)', 
          liveUp, liveDown, 
          wsUp != null ? 'WS' : (upMid != null ? 'MID' : 'API'),
          wsDown != null ? 'WS' : (downMid != null ? 'MID' : 'API'));

        // Sanity: if sum drifts too far from parity, fallback to API prices
        const sum = (liveUp || 0) + (liveDown || 0);
        if (sum < 90 || sum > 110) {
          console.warn('[Live Prices] sanity fallback: sum=%.2f (up=%.2f down=%.2f), reverting to API', sum, liveUp, liveDown);
          liveUp = state.upPrice;
          liveDown = state.downPrice;
          console.warn('[Live Prices] forcing WS reconnect due to parity failure');
          livePriceFeed.forceReconnect();
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

    // Broadcast positions
    const positionsArray = Array.from(positions.values()).map((pos) => ({
      tokenId: pos.tokenId,
      outcome: pos.outcome,
      size: pos.size,
      avgBuyPrice: pos.avgBuyPrice,
      currentPrice: pos.currentPrice,
      unrealizedPnl: (pos.currentPrice - pos.avgBuyPrice) * pos.size,
    }));
    broadcast('positions', positionsArray);

    // 當前市場 ID（僅供日誌使用）
    const marketId = state.nextMarket?.conditionId || state.currentMarket?.conditionId || '';

    // 檢查現有持倉是否需要補掛 Limit Sell 或清理剩餘
    for (const [tokenId, pos] of positions) {
      if (pos.size > 0 && !config.PAPER_TRADING) {
        // 先嘗試補掛 Limit Sell
        await trader.placeLimitSellForPosition(tokenId, pos.outcome, pos.avgBuyPrice);
        await delay(300);
        // 清理剩餘小數股份（< 1 股）
        await trader.marketSellRemainder(tokenId, pos.outcome, pos.currentPrice);
        await delay(300);
      }
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
          success = await trader.sell(signal.tokenId, signal.outcome, signal.price, signal.size);
        }
      }

      await delay(500); // Rate limit between trades
      if (success) {
        // Broadcast trade
        broadcast('trade', {
          id: Date.now().toString(),
          timestamp: Date.now(),
          market: state.nextMarket?.question || state.currentMarket?.question || 'Unknown',
          outcome: signal.outcome,
          side: signal.action,
          price: signal.price,
          size: signal.size,
          pnl: signal.action === 'SELL' ? (signal.price - (positions.get(signal.tokenId)?.avgBuyPrice || signal.price)) * signal.size : undefined,
        });
      }
    }

    // Broadcast PnL stats
    const history = trader.getTradeHistory();
    const totalPnl = history.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const wins = history.filter((t) => (t.pnl || 0) > 0).length;
    const totalTrades = history.filter((t) => t.side === 'SELL').length;

    broadcast('pnl', {
      totalPnl,
      totalTrades,
      winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    });

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

  const loop = async () => {
    if (!botRunning) return;
    await tick();
    setTimeout(loop, config.POLL_INTERVAL_MS);
  };
  loop();

  // Sync server time
  await fetcher.syncServerTime();

  // Initialize trader
  const initialized = await trader.initialize();
  if (!initialized && !config.PAPER_TRADING) {
    console.error('❌ Failed to initialize trader');
    return;
  }

  botRunning = true;
  botInterval = setInterval(tick, config.POLL_INTERVAL_MS);

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
        profitTarget: config.PROFIT_TARGET,
        stopLoss: config.STOP_LOSS,
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
          if (payload.profitTarget) {
            (config as any).PROFIT_TARGET = payload.profitTarget;
          }
          if (payload.maxPositionSize) {
            (config as any).MAX_POSITION_SIZE = payload.maxPositionSize;
          }
          if (payload.stopLoss) {
            (config as any).STOP_LOSS = payload.stopLoss;
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
