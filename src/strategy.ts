import { config } from './config.js';
import { riskManager } from './risk-manager.js';
import { aiAnalyzer, type AIAnalysis } from './ai-analyzer.js';
import { llmAnalyzer, type LLMAnalysis } from './llm-analyzer.js';
import type { MarketState, TradeSignal, Position, OrderBook } from './types.js';

/**
 * 盤前套利策略 (包含風控)
 * 
 * 核心邏輯：
 * 1. 只在盤前（下一局開始前）買入價格 < 50¢ 的 Up 或 Down
 * 2. 當價格上升 >= 2¢ 時立即賣出獲利
 * 3. 開局時必須清倉所有持倉
 * 4. 分析當前進行中的盤口走勢來預測下一局盤前價格波動
 * 
 * 風控：
 * - 滑點保護: 檢查訂單簿深度
 * - 手續費計算: 確保淨利潤 > 0
 * - 時間窗口: 開盤前 60秒強制清倉
 */
export class Strategy {
  private lastPrices: Map<string, number[]> = new Map();
  private readonly PRICE_HISTORY_LENGTH = 60;
  private minProfitableMove: number = 0; // 考慮手續費後的最小獲利價格變動
  private lastAIAnalysis: { next: AIAnalysis | null; current: AIAnalysis | null } = { next: null, current: null }; // 最近一次 AI 分析結果
  private lastLLMAnalysis: { next: LLMAnalysis | null; current: LLMAnalysis | null } = { next: null, current: null }; // 最近一次 LLM 分析結果
  private cachedOrderBooks: {
    next: { up: OrderBook; down: OrderBook } | null;
    current: { up: OrderBook; down: OrderBook } | null;
  } = { next: null, current: null };
  private pendingLLMAnalysis: { next: Promise<LLMAnalysis> | null; current: Promise<LLMAnalysis> | null } = { next: null, current: null };
  private livePrices: Record<string, number> = {};
  private btcSpot: number | null = null;
  private lossStreaks: Record<'Up' | 'Down', { streak: number; cooldownUntil: number }> = {
    Up: { streak: 0, cooldownUntil: 0 },
    Down: { streak: 0, cooldownUntil: 0 },
  };

  /**
   * 分析當前盤口走勢
   * 返回預測的下一局有利方向
   */
  analyzeCurrentMarketTrend(state: MarketState): 'Up' | 'Down' | null {
    if (!state.currentMarket) return null;

    // 簡單策略：如果當前盤口 Up 價格高，下一局盤前可能 Up 會先漲
    // 這是基於市場慣性的假設
    const upPrice = state.upPrice;
    const downPrice = state.downPrice;

    if (upPrice > 55) return 'Up'; // 當前看漲，盤前可能延續
    if (downPrice > 55) return 'Down';

    return null; // 無明顯趨勢
  }

  /**
   * 計算價格動量
   */
  calculateMomentum(tokenId: string, currentPrice: number): number {
    const history = this.lastPrices.get(tokenId) || [];

    const effectiveHistory = [...history, currentPrice];
    const lookback = 3;
    const recentPrices = effectiveHistory.slice(-lookback);
    if (recentPrices.length === 0) return 0;

    const avgRecent = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const momentum = currentPrice - avgRecent;

    this.updatePriceHistory(tokenId, currentPrice);
    return momentum;
  }

  private updatePriceHistory(tokenId: string, price: number): void {
    const history = this.lastPrices.get(tokenId) || [];
    history.push(price);
    if (history.length > this.PRICE_HISTORY_LENGTH) {
      history.shift();
    }
    this.lastPrices.set(tokenId, history);
  }

  /**
   * 生成交易信號
   */
  generateSignals(
    state: MarketState,
    positions: Map<string, Position>
  ): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const now = Date.now();

    // 情況 0: 檢測並清倉已結束市場的持倉（orphaned positions）
    const validTokenIds = new Set([
      state.upTokenId,
      state.downTokenId,
      state.currentUpTokenId,
      state.currentDownTokenId,
    ].filter(id => id)); // 過濾空字串
    
    for (const [tokenId, position] of positions) {
      if (position.size > 0 && !validTokenIds.has(tokenId)) {
        console.log(`[策略] 發現已結束市場的持倉: ${position.outcome} ${position.size} 股，強制清倉`);
        signals.push({
          action: 'SELL',
          tokenId,
          outcome: position.outcome,
          price: position.currentPrice,
          size: position.size,
          reason: `清倉已結束市場持倉`,
        });
      }
    }
    
    if (signals.length > 0) {
      return signals;
    }

    // 情況 1a: 下一個市場開局前強制清倉（只針對「當前市場」持倉，不清空下一市場持倉）
    if (state.nextMarket && state.timeToStart <= config.SELL_BEFORE_START_MS) {
      for (const [tokenId, position] of positions) {
        const isCurrent = tokenId === state.currentUpTokenId || tokenId === state.currentDownTokenId;
        if (position.size > 0 && isCurrent) {
          signals.push({
            action: 'SELL',
            tokenId,
            outcome: position.outcome,
            price: position.currentPrice,
            size: position.size,
            reason: `開局清倉 (距離開盤 ${Math.round(state.timeToStart / 1000)}s)`,
          });
        }
      }
      if (signals.length > 0) return signals;
    }

    // 情況 1b: 當前市場即將結束時強制清倉（防止持倉到結算）
    if (state.currentMarket && state.timeToEnd > 0 && state.timeToEnd <= config.SELL_BEFORE_START_MS) {
      for (const [tokenId, position] of positions) {
        if (position.size > 0) {
          signals.push({
            action: 'SELL',
            tokenId,
            outcome: position.outcome,
            price: position.currentPrice,
            size: position.size,
            reason: `開局清倉 (當前市場剩餘 ${Math.round(state.timeToEnd / 1000)}s)`,
          });
        }
      }
      return signals;
    }

    const isPreMarket = !state.currentMarket && state.timeToStart > 0;
    if (!isPreMarket) {
      // 情況 2a: 止損賣出 - 當虧損超過止損點時賣出
      for (const [tokenId, position] of positions) {
        if (position.size > 0) {
          const loss = position.avgBuyPrice - position.currentPrice;
          const lossPct = position.avgBuyPrice > 0 ? loss / position.avgBuyPrice : 0;
          const pctThreshold = config.STOP_LOSS_PCT * position.avgBuyPrice; // cents
          const centThreshold = config.STOP_LOSS; // cents
          const triggerThreshold = Math.min(centThreshold, pctThreshold || Number.POSITIVE_INFINITY);
          if (loss >= triggerThreshold) {
            console.log(`[策略] 觸發止損: ${position.outcome} loss=${loss.toFixed(2)}¢ (${(lossPct * 100).toFixed(2)}%) >= threshold=${triggerThreshold.toFixed(2)}¢ (pct=${(config.STOP_LOSS_PCT * 100).toFixed(2)}%, abs=${centThreshold}¢)`);
            signals.push({
              action: 'SELL',
              tokenId,
              outcome: position.outcome,
              price: position.currentPrice,
              size: position.size,
              reason: `止損賣出 @ ${position.currentPrice.toFixed(1)}¢ (loss: -${loss.toFixed(2)}¢, ${(lossPct * 100).toFixed(2)}%)`,
            });
          }
        }
      }
      
      if (signals.length > 0) {
        return signals;
      }

      // 情況 2b: 獲利賣出 - 當價格達到目標時主動賣出
      for (const [tokenId, position] of positions) {
        if (position.size > 0) {
          const profit = position.currentPrice - position.avgBuyPrice;
          const profitPct = position.avgBuyPrice > 0 ? profit / position.avgBuyPrice : 0;
          if (profitPct >= config.PROFIT_TARGET_PCT) {
            console.log(`[策略] 達到獲利目標: ${position.outcome} profit=${profit.toFixed(2)}¢ (${(profitPct * 100).toFixed(2)}%) >= targetPct=${(config.PROFIT_TARGET_PCT * 100).toFixed(2)}%`);
            signals.push({
              action: 'SELL',
              tokenId,
              outcome: position.outcome,
              price: position.currentPrice,
              size: position.size,
              reason: `獲利賣出 @ ${position.currentPrice.toFixed(1)}¢ (profit: ${profit.toFixed(2)}¢, ${(profitPct * 100).toFixed(2)}%)`,
            });
          }
        }
      }
      
      // 如果有獲利賣出信號，先處理賣出
      if (signals.length > 0) {
        return signals;
      }
    }

    // 情況 3: 盤前買入機會 (檢查時間窗口)
    const timeCheck = riskManager.checkTimeWindow(state.timeToStart);
    console.log(`[策略] 時間檢查: canTrade=${timeCheck.canTrade}, reason=${timeCheck.reason}, timeToStart=${state.timeToStart}ms`);
    
    if (!timeCheck.canTrade) {
      return signals;
    }

    // 情況 4a: 盤前買入（下一個市場）
    if (state.nextMarket && state.timeToStart > config.MIN_TIME_TO_TRADE_MS) {
      const signal = this.tryBuyWithAI(
        state,
        positions,
        state.upTokenId,
        state.downTokenId,
        state.upPrice,
        state.downPrice,
        '盤前',
        this.cachedOrderBooks.next as any,
        'next'
      );
      if (signal) {
        signals.push(signal);
      }
    }
    
    // 情況 4b: 盤中低吸（當前市場）- 市場進行中且距離結束還有足夠時間
    if (config.ALLOW_CURRENT_MARKET_TRADING && state.currentMarket && state.timeToEnd > config.SELL_BEFORE_START_MS + 60000) { // 至少比清倉時間多 1 分鐘
      const signal = this.tryBuyWithAI(
        state,
        positions,
        state.currentUpTokenId,
        state.currentDownTokenId,
        state.currentUpPrice,
        state.currentDownPrice,
        '盤中低吸',
        (this.cachedOrderBooks.current || this.cachedOrderBooks.next) as any,
        'current'
      );
      if (signal) {
        signals.push(signal);
      }
    }

    return signals;
  }

  /**
   * 設置訂單簿緩存（由外部調用者提供）
   */
  setOrderBooks(
    nextUpOrderBook: OrderBook,
    nextDownOrderBook: OrderBook,
    currentUpOrderBook?: OrderBook,
    currentDownOrderBook?: OrderBook
  ): void {
    this.cachedOrderBooks.next = { up: nextUpOrderBook, down: nextDownOrderBook };
    if (currentUpOrderBook && currentDownOrderBook) {
      this.cachedOrderBooks.current = { up: currentUpOrderBook, down: currentDownOrderBook };
    }
  }

  setLivePrices(prices: Record<string, number>): void {
    this.livePrices = prices;
  }

  setBtcSpot(price: number | null): void {
    this.btcSpot = price;
  }

  /**
   * 獲取最近一次 AI 分析結果
   */
  getLastAIAnalysis(scope: 'next' | 'current' = 'next'): AIAnalysis | null {
    return this.lastAIAnalysis[scope];
  }

  /**
   * 獲取最近一次 LLM 分析結果
   */
  getLastLLMAnalysis(scope: 'next' | 'current' = 'next'): LLMAnalysis | null {
    return this.lastLLMAnalysis[scope];
  }

  /**
   * 預先觸發 LLM 分析（非阻塞）
   */
  triggerLLMAnalysis(state: MarketState, positions: Map<string, Position>): void {
    if (!config.LLM_ENABLED || !llmAnalyzer.isAvailable()) return;

    const launch = (scope: 'next' | 'current', orderBooks?: { up: OrderBook; down: OrderBook }) => {
      if (!orderBooks) return;
      if (scope === 'current' && state.timeToEnd < 180_000) return; // skip current market if <3 minutes left
      if (this.pendingLLMAnalysis[scope]) return; // already running
      this.pendingLLMAnalysis[scope] = llmAnalyzer.analyze(state, orderBooks.up, orderBooks.down, positions)
        .then(analysis => {
          this.lastLLMAnalysis[scope] = analysis;
          this.pendingLLMAnalysis[scope] = null;
          console.log(llmAnalyzer.getAnalysisSummary(analysis));
          return analysis;
        })
        .catch(err => {
          console.error('[LLM] 分析失敗:', err);
          this.pendingLLMAnalysis[scope] = null;
          return this.getDefaultLLMAnalysis();
        });
    };

    launch('next', this.cachedOrderBooks.next || undefined);
    launch('current', this.cachedOrderBooks.current || undefined);
  }

  /**
   * 預先刷新 AI 分析（規則式）for both scopes
   */
  refreshAIAnalyses(state: MarketState, positions: Map<string, Position>): void {
    if (!config.AI_ENABLED) return;
    if (this.cachedOrderBooks.next) {
      this.lastAIAnalysis.next = this.runAIAnalysisSync(state, positions, this.cachedOrderBooks.next, this.livePrices, this.btcSpot ?? undefined);
    }
    if (this.cachedOrderBooks.current) {
      this.lastAIAnalysis.current = this.runAIAnalysisSync(state, positions, this.cachedOrderBooks.current, this.livePrices, this.btcSpot ?? undefined);
    }
  }

  private getDefaultLLMAnalysis(): LLMAnalysis {
    return {
      shouldTrade: false,
      recommendedOutcome: null,
      confidence: 0,
      recommendedSize: 0,
      reasoning: 'LLM 分析不可用',
      marketSummary: 'N/A',
    };
  }

  /**
    if (!analysis || !analysis.shouldTrade || !analysis.recommendedOutcome) {
      console.log(`[LLM] 不建議交易: ${analysis?.reasoning || 'unknown'}`);
      return null;
    }

    const isUp = analysis.recommendedOutcome === 'Up';
    const tokenId = isUp ? upTokenId : downTokenId;
    const price = isUp ? upPrice : downPrice;
    const oppositeTokenId = isUp ? downTokenId : upTokenId;
    const oppositeSize = positions.get(oppositeTokenId)?.size ?? 0;
    if (oppositeSize > 0) {
      console.log(`[AI] 已持有相反倉位 ${oppositeSize.toFixed(3)} 股，先賣出再買 ${analysis.recommendedOutcome}`);
      return null;
    }

    const combinedPriceCents = (positions.get(upTokenId)?.currentPrice ?? upPrice) + (positions.get(downTokenId)?.currentPrice ?? downPrice);
    if (combinedPriceCents >= config.COMBINED_PRICE_CAP * 100) {
      console.log(`[LLM] 雙邊價格過高 up+down=${combinedPriceCents.toFixed(1)}¢ >= cap ${config.COMBINED_PRICE_CAP * 100}¢，不買`);
      return null;
    }
    const cooldown = this.lossStreaks[analysis.recommendedOutcome]?.cooldownUntil || 0;
    if (cooldown > Date.now()) {
      console.log(`[AI] 冷卻中 (${analysis.recommendedOutcome}) until ${new Date(cooldown).toISOString()}, skip buy`);
      return null;
    }

    if (price >= 98) {
      console.log(`[AI] 價格過高 (${price.toFixed(1)}¢) 不買`);
      return null;
    }

    return {
      action: 'BUY',
      tokenId,
      outcome: analysis.recommendedOutcome,
      price,
      size: analysis.recommendedSize,
      reason: `[LLM] ${label}買入 ${analysis.recommendedOutcome} @ ${price.toFixed(1)}¢ (信心: ${analysis.confidence}%) | ${analysis.reasoning}`,
    };
  }

  /**
   * 規則式 AI 分析買入決策
   */
  private tryBuyWithAI(
    state: MarketState,
    positions: Map<string, Position>,
    upTokenId: string,
    downTokenId: string,
    upPrice: number,
    downPrice: number,
    label: string,
    orderBooks: { up: OrderBook; down: OrderBook },
    scope: 'next' | 'current'
  ): TradeSignal | null {
    // 同步執行 AI 分析（使用指定的訂單簿）
    const analysis = this.runAIAnalysisSync(state, positions, orderBooks, this.livePrices, this.btcSpot ?? undefined);
    this.lastAIAnalysis[scope] = analysis;

    // 輸出 AI 分析摘要
    console.log(aiAnalyzer.getAnalysisSummary(analysis));

    if (!analysis.recommendedOutcome) {
      console.log(`[AI] 無推薦方向: ${analysis.reasons[0] || 'unknown'}`);
      return null;
    }

    const isUp = analysis.recommendedOutcome === 'Up';
    const tokenId = isUp ? upTokenId : downTokenId;
    const price = isUp ? upPrice : downPrice;
    const oppositeTokenId = isUp ? downTokenId : upTokenId;
    const oppositeSize = positions.get(oppositeTokenId)?.size ?? 0;
    if (oppositeSize > 0) {
      console.log(`[AI] 已持有相反倉位 ${oppositeSize.toFixed(3)} 股，先賣出再買 ${analysis.recommendedOutcome}`);
      return null;
    }

    if (price < config.PRICE_FLOOR) {
      console.log(`[AI] 價格低於下限 ${config.PRICE_FLOOR}¢ (got ${price.toFixed(2)}¢), 不買`);
      return null;
    }

    if (price > config.PRICE_CEILING) {
      console.log(`[AI] 價格高於上限 ${config.PRICE_CEILING}¢ (got ${price.toFixed(2)}¢), 不買`);
      return null;
    }

    // Combined cap guard (skip only if leader pre-start override below)
    const combinedPriceCents = (positions.get(upTokenId)?.currentPrice ?? upPrice) + (positions.get(downTokenId)?.currentPrice ?? downPrice);

    // Leader pre-start override: only for next market, gap 5-8¢, toggle on
    const isPreStart = scope === 'next' && state.timeToStart > 0;
    const priceGap = Math.abs(upPrice - downPrice);
    const leaderOutcome: 'Up' | 'Down' | null = upPrice > downPrice ? 'Up' : downPrice > upPrice ? 'Down' : null;
    const leaderOverride = config.BUY_LEADER_PRESTART && isPreStart && leaderOutcome && priceGap >= 5 && priceGap <= 8;

    if (!leaderOverride && combinedPriceCents >= config.COMBINED_PRICE_CAP * 100) {
      console.log(`[AI] 雙邊價格過高 up+down=${combinedPriceCents.toFixed(1)}¢ >= cap ${config.COMBINED_PRICE_CAP * 100}¢，不買`);
      return null;
    }

    const existingSize = positions.get(tokenId)?.size ?? 0;
    const remainingCap = Math.max(0, config.MAX_POSITION_SIZE - existingSize);
    if (remainingCap <= 0) {
      console.log(`[AI] 已達最大倉位 ${config.MAX_POSITION_SIZE}, 不再加倉 ${analysis.recommendedOutcome}`);
      return null;
    }

    const finalSize = Math.min(analysis.recommendedSize, remainingCap);

    // If leader override, force buy leader outcome regardless of AI pick, bypass combined cap
    if (leaderOverride) {
      const tokenIdLeader = leaderOutcome === 'Up' ? upTokenId : downTokenId;
      const priceLeader = leaderOutcome === 'Up' ? upPrice : downPrice;
      console.log(`[AI][LeaderOverride] Gap=${priceGap.toFixed(1)}¢ (${leaderOutcome}) pre-start -> 買入領先方 (忽略 combined cap)`);
      return {
        action: 'BUY',
        tokenId: tokenIdLeader,
        outcome: leaderOutcome,
        price: priceLeader,
        size: finalSize,
        reason: `[LeaderOverride] Pre-start leader ${leaderOutcome} gap=${priceGap.toFixed(1)}¢ (cap bypass)`,
      };
    }

    return {
      action: 'BUY',
      tokenId,
      outcome: analysis.recommendedOutcome,
      price,
      size: finalSize,
      reason: `[AI] ${label}買入 ${analysis.recommendedOutcome} @ ${price.toFixed(1)}¢ (信心: ${analysis.confidence.toFixed(0)}%, 倉位: ${finalSize}/${config.MAX_POSITION_SIZE})`,
    };
  }

  /**
   * 同步執行 AI 分析
   */
  private runAIAnalysisSync(
    state: MarketState,
    positions: Map<string, Position>,
    orderBooks: { up: OrderBook; down: OrderBook } | null,
    livePrices?: Record<string, number>,
    btcSpot?: number
  ): AIAnalysis {
    if (!orderBooks) {
      return {
        shouldTrade: false,
        recommendedOutcome: null,
        confidence: 0,
        recommendedSize: 0,
        reasons: ['無訂單簿數據'],
        signals: {
          technical: { momentum: 0, volatility: 0, rsi: 50, trend: 'neutral', score: 0 },
          orderBook: { bidAskSpread: 0, depthImbalance: 0, liquidityScore: 0, score: 0 },
          sentiment: { priceDeviation: 0, recentWinRate: 50, marketBias: 'neutral', score: 0 },
          timing: { timeToStart: 0, optimalWindow: false, urgency: 0, score: 0 },
        },
      };
    }

    // 直接調用同步版本的 analyze
    const spot = btcSpot ?? this.btcSpot ?? undefined;
    return aiAnalyzer.analyzeSync(state, orderBooks.up, orderBooks.down, positions, livePrices, spot);
  }

  setLossStreaks(lossState: Record<'Up' | 'Down', { streak: number; cooldownUntil: number }>): void {
    this.lossStreaks = lossState;
  }

  /**
   * 傳統買入邏輯（AI 關閉時使用）
   */
  private tryBuyLegacy(
    state: MarketState,
    positions: Map<string, Position>,
    upTokenId: string,
    downTokenId: string,
    upPrice: number,
    downPrice: number,
    label: string,
    trend: 'Up' | 'Down' | null
  ): TradeSignal | null {
    // 檢查 Up
    if (upPrice >= config.PRICE_FLOOR && upPrice <= config.PRICE_CEILING && upPrice < config.MAX_BUY_PRICE) {
      const downHeld = positions.get(downTokenId)?.size ?? 0;
      if (downHeld > 0) {
        console.log(`[Legacy] 已持有 Down ${downHeld.toFixed(3)} 股，先賣出再買 Up`);
        return null;
      }
      const combinedPriceCents = (positions.get(upTokenId)?.currentPrice ?? upPrice) + (positions.get(downTokenId)?.currentPrice ?? downPrice);
      if (combinedPriceCents >= config.COMBINED_PRICE_CAP * 100) {
        console.log(`[Legacy] 雙邊價格過高 up+down=${combinedPriceCents.toFixed(1)}¢ >= cap ${config.COMBINED_PRICE_CAP * 100}¢，不買 Up`);
        return null;
      }
      const cooldown = this.lossStreaks['Up']?.cooldownUntil || 0;
      if (cooldown > Date.now()) {
        console.log(`[Legacy] Up 冷卻中 until ${new Date(cooldown).toISOString()}, skip buy`);
        return null;
      }
      const upMomentum = this.calculateMomentum(upTokenId, upPrice);
      const existing = positions.get(upTokenId)?.size ?? 0;
      const remaining = Math.max(0, config.MAX_POSITION_SIZE - existing);
      if (remaining <= 0) return null;
      if (upPrice >= 98) return null;
      return {
        action: 'BUY',
        tokenId: upTokenId,
        outcome: 'Up',
        price: upPrice,
        size: remaining,
        reason: `${label}買入 Up @ ${upPrice.toFixed(1)}¢ (trend: ${trend || 'none'}, momentum: ${upMomentum.toFixed(2)})`,
      };
    }

    // 如果 Up 價格太高，檢查 Down
    if (downPrice >= config.PRICE_FLOOR && downPrice <= config.PRICE_CEILING && downPrice < config.MAX_BUY_PRICE) {
      const upHeld = positions.get(upTokenId)?.size ?? 0;
      if (upHeld > 0) {
        console.log(`[Legacy] 已持有 Up ${upHeld.toFixed(3)} 股，先賣出再買 Down`);
        return null;
      }
      const combinedPriceCents = upPrice + downPrice;
      if (combinedPriceCents >= config.COMBINED_PRICE_CAP * 100) {
        console.log(`[Legacy] 雙邊價格過高 up+down=${combinedPriceCents.toFixed(1)}¢ >= cap ${config.COMBINED_PRICE_CAP * 100}¢，不買 Down`);
        return null;
      }
      const cooldown = this.lossStreaks['Down']?.cooldownUntil || 0;
      if (cooldown > Date.now()) {
        console.log(`[Legacy] Down 冷卻中 until ${new Date(cooldown).toISOString()}, skip buy`);
        return null;
      }
      const downMomentum = this.calculateMomentum(downTokenId, downPrice);
      const existing = positions.get(downTokenId)?.size ?? 0;
      const remaining = Math.max(0, config.MAX_POSITION_SIZE - existing);
      if (remaining <= 0) return null;
      if (downPrice >= 98) return null;
      return {
        action: 'BUY',
        tokenId: downTokenId,
        outcome: 'Down',
        price: downPrice,
        size: remaining,
        reason: `${label}買入 Down @ ${downPrice.toFixed(1)}¢ (trend: ${trend || 'none'}, momentum: ${downMomentum.toFixed(2)})`,
      };
    }

    return null;
  }

  /**
   * 更新持倉的當前價格
   */
  updatePositionPrices(
    positions: Map<string, Position>,
    state: MarketState
  ): void {
    for (const [tokenId, position] of positions) {
      const live = this.livePrices[tokenId];
      if (tokenId === state.upTokenId) {
        position.currentPrice = state.upPrice ?? live ?? position.currentPrice;
      } else if (tokenId === state.downTokenId) {
        position.currentPrice = state.downPrice ?? live ?? position.currentPrice;
      } else if (tokenId === state.currentUpTokenId) {
        position.currentPrice = state.currentUpPrice ?? live ?? position.currentPrice;
      } else if (tokenId === state.currentDownTokenId) {
        position.currentPrice = state.currentDownPrice ?? live ?? position.currentPrice;
      } else if (live != null) {
        position.currentPrice = live;
      }

      if (position.currentPrice === undefined || position.currentPrice === null) {
        console.warn('[止損] 無法更新持倉價格', tokenId, position.outcome);
      }
    }
  }
}
