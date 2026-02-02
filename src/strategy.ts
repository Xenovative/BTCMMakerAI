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
  private lastAIAnalysis: AIAnalysis | null = null; // 最近一次 AI 分析結果
  private lastLLMAnalysis: LLMAnalysis | null = null; // 最近一次 LLM 分析結果
  private cachedOrderBooks: { up: OrderBook; down: OrderBook } | null = null;
  private pendingLLMAnalysis: Promise<LLMAnalysis> | null = null;

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
    
    if (history.length < 5) {
      this.updatePriceHistory(tokenId, currentPrice);
      return 0;
    }

    // 計算短期動量 (最近 5 個價格點)
    const recentPrices = history.slice(-5);
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

    // 情況 1a: 下一個市場開局前強制清倉
    if (state.nextMarket && state.timeToStart <= config.SELL_BEFORE_START_MS) {
      for (const [tokenId, position] of positions) {
        if (position.size > 0) {
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
      return signals;
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

    // 情況 2a: 止損賣出 - 當虧損超過止損點時賣出
    for (const [tokenId, position] of positions) {
      if (position.size > 0) {
        const loss = position.avgBuyPrice - position.currentPrice;
        if (loss >= config.STOP_LOSS) {
          console.log(`[策略] 觸發止損: ${position.outcome} loss=${loss.toFixed(2)}¢ >= stopLoss=${config.STOP_LOSS}¢`);
          signals.push({
            action: 'SELL',
            tokenId,
            outcome: position.outcome,
            price: position.currentPrice,
            size: position.size,
            reason: `止損賣出 @ ${position.currentPrice.toFixed(1)}¢ (loss: -${loss.toFixed(2)}¢)`,
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
        if (profit >= config.PROFIT_TARGET) {
          console.log(`[策略] 達到獲利目標: ${position.outcome} profit=${profit.toFixed(2)}¢ >= target=${config.PROFIT_TARGET}¢`);
          signals.push({
            action: 'SELL',
            tokenId,
            outcome: position.outcome,
            price: position.currentPrice,
            size: position.size,
            reason: `獲利賣出 @ ${position.currentPrice.toFixed(1)}¢ (profit: ${profit.toFixed(2)}¢)`,
          });
        }
      }
    }
    
    // 如果有獲利賣出信號，先處理賣出
    if (signals.length > 0) {
      return signals;
    }

    // 情況 3: 盤前買入機會 (檢查時間窗口)
    const timeCheck = riskManager.checkTimeWindow(state.timeToStart);
    console.log(`[策略] 時間檢查: canTrade=${timeCheck.canTrade}, reason=${timeCheck.reason}, timeToStart=${state.timeToStart}ms`);
    
    if (!timeCheck.canTrade) {
      return signals;
    }

    // 情況 4a: 盤前買入（下一個市場）
    if (state.nextMarket && state.timeToStart > config.MIN_TIME_TO_TRADE_MS) {
      const signal = this.tryBuyMarket(state, positions, state.upTokenId, state.downTokenId, state.upPrice, state.downPrice, '盤前');
      if (signal) {
        signals.push(signal);
        return signals;
      }
    }
    
    // 情況 4b: 盤中低吸（當前市場）- 市場進行中且距離結束還有足夠時間
    if (config.ALLOW_CURRENT_MARKET_TRADING && state.currentMarket && state.timeToEnd > config.SELL_BEFORE_START_MS + 60000) { // 至少比清倉時間多 1 分鐘
      const signal = this.tryBuyMarket(state, positions, state.currentUpTokenId, state.currentDownTokenId, state.currentUpPrice, state.currentDownPrice, '盤中低吸');
      if (signal) {
        signals.push(signal);
        return signals;
      }
    }

    return signals;
  }

  /**
   * 設置訂單簿緩存（由外部調用者提供）
   */
  setOrderBooks(upOrderBook: OrderBook, downOrderBook: OrderBook): void {
    this.cachedOrderBooks = { up: upOrderBook, down: downOrderBook };
  }

  /**
   * 獲取最近一次 AI 分析結果
   */
  getLastAIAnalysis(): AIAnalysis | null {
    return this.lastAIAnalysis;
  }

  /**
   * 獲取最近一次 LLM 分析結果
   */
  getLastLLMAnalysis(): LLMAnalysis | null {
    return this.lastLLMAnalysis;
  }

  /**
   * 預先觸發 LLM 分析（非阻塞）
   */
  triggerLLMAnalysis(state: MarketState, positions: Map<string, Position>): void {
    if (!config.LLM_ENABLED || !llmAnalyzer.isAvailable() || !this.cachedOrderBooks) {
      return;
    }
    
    // 如果已經有待處理的分析，不重複觸發
    if (this.pendingLLMAnalysis) {
      return;
    }

    this.pendingLLMAnalysis = llmAnalyzer.analyze(
      state,
      this.cachedOrderBooks.up,
      this.cachedOrderBooks.down,
      positions
    ).then(analysis => {
      this.lastLLMAnalysis = analysis;
      this.pendingLLMAnalysis = null;
      console.log(llmAnalyzer.getAnalysisSummary(analysis));
      return analysis;
    }).catch(err => {
      console.error('[LLM] 分析失敗:', err);
      this.pendingLLMAnalysis = null;
      return this.getDefaultLLMAnalysis();
    });
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
   * 嘗試在指定市場買入（支持 AI 模式）
   */
  private tryBuyMarket(
    state: MarketState,
    positions: Map<string, Position>,
    upTokenId: string,
    downTokenId: string,
    upPrice: number,
    downPrice: number,
    label: string
  ): TradeSignal | null {
    if (!upTokenId || !downTokenId) return null;
    
    const trend = this.analyzeCurrentMarketTrend(state);

    // 計算考慮手續費後的最小獲利價格變動
    const minMove = riskManager.calculateMinPriceMove(
      upPrice,
      config.PROFIT_TARGET,
      config.MAX_POSITION_SIZE
    );
    this.minProfitableMove = minMove;

    console.log(`[策略] ${label}買入條件檢查: trend=${trend}, minMove=${minMove.toFixed(2)}¢`);
    console.log(`[策略] Up: price=${upPrice.toFixed(1)}¢, hasPosition=${positions.has(upTokenId)}`);
    console.log(`[策略] Down: price=${downPrice.toFixed(1)}¢, hasPosition=${positions.has(downTokenId)}`);

    // 檢查是否已有該市場的持倉 - 每個市場只買一次
    const hasPositionInThisMarket = positions.has(upTokenId) || positions.has(downTokenId);
    if (hasPositionInThisMarket) {
      console.log(`[策略] 已有該市場持倉，不再買入`);
      return null;
    }

    // ==================== LLM 分析模式（優先） ====================
    if (config.LLM_ENABLED && llmAnalyzer.isAvailable() && this.lastLLMAnalysis) {
      return this.tryBuyWithLLM(state, upTokenId, downTokenId, upPrice, downPrice, label);
    }

    // ==================== 規則式 AI 分析模式（後備） ====================
    if (config.AI_ENABLED && this.cachedOrderBooks) {
      return this.tryBuyWithAI(state, positions, upTokenId, downTokenId, upPrice, downPrice, label);
    }

    // ==================== 傳統模式（所有 AI 關閉時的後備） ====================
    return this.tryBuyLegacy(state, upTokenId, downTokenId, upPrice, downPrice, label, trend);
  }

  /**
   * LLM 分析買入決策
   */
  private tryBuyWithLLM(
    state: MarketState,
    upTokenId: string,
    downTokenId: string,
    upPrice: number,
    downPrice: number,
    label: string
  ): TradeSignal | null {
    const analysis = this.lastLLMAnalysis;
    if (!analysis || !analysis.shouldTrade || !analysis.recommendedOutcome) {
      console.log(`[LLM] 不建議交易: ${analysis?.reasoning || 'unknown'}`);
      return null;
    }

    const isUp = analysis.recommendedOutcome === 'Up';
    const tokenId = isUp ? upTokenId : downTokenId;
    const price = isUp ? upPrice : downPrice;

    // 檢查價格是否在可接受範圍
    if (price >= config.MAX_BUY_PRICE) {
      console.log(`[LLM] 價格過高: ${price.toFixed(1)}¢ >= ${config.MAX_BUY_PRICE}¢`);
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
    label: string
  ): TradeSignal | null {
    if (!this.cachedOrderBooks) return null;

    // 同步執行 AI 分析（使用緩存的訂單簿）
    const analysis = this.runAIAnalysisSync(state, positions);
    this.lastAIAnalysis = analysis;

    // 輸出 AI 分析摘要
    console.log(aiAnalyzer.getAnalysisSummary(analysis));

    if (!analysis.shouldTrade || !analysis.recommendedOutcome) {
      console.log(`[AI] 不建議交易: ${analysis.reasons[0] || 'unknown'}`);
      return null;
    }

    const isUp = analysis.recommendedOutcome === 'Up';
    const tokenId = isUp ? upTokenId : downTokenId;
    const price = isUp ? upPrice : downPrice;

    return {
      action: 'BUY',
      tokenId,
      outcome: analysis.recommendedOutcome,
      price,
      size: analysis.recommendedSize,
      reason: `[AI] ${label}買入 ${analysis.recommendedOutcome} @ ${price.toFixed(1)}¢ (信心: ${analysis.confidence.toFixed(0)}%, 倉位: ${analysis.recommendedSize})`,
    };
  }

  /**
   * 同步執行 AI 分析
   */
  private runAIAnalysisSync(
    state: MarketState,
    positions: Map<string, Position>
  ): AIAnalysis {
    if (!this.cachedOrderBooks) {
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
    return aiAnalyzer.analyzeSync(state, this.cachedOrderBooks.up, this.cachedOrderBooks.down, positions);
  }

  /**
   * 傳統買入邏輯（AI 關閉時使用）
   */
  private tryBuyLegacy(
    state: MarketState,
    upTokenId: string,
    downTokenId: string,
    upPrice: number,
    downPrice: number,
    label: string,
    trend: 'Up' | 'Down' | null
  ): TradeSignal | null {
    // 檢查 Up
    if (upPrice < config.MAX_BUY_PRICE) {
      const upMomentum = this.calculateMomentum(upTokenId, upPrice);
      return {
        action: 'BUY',
        tokenId: upTokenId,
        outcome: 'Up',
        price: upPrice,
        size: config.MAX_POSITION_SIZE,
        reason: `${label}買入 Up @ ${upPrice.toFixed(1)}¢ (trend: ${trend || 'none'}, momentum: ${upMomentum.toFixed(2)})`,
      };
    }

    // 如果 Up 價格太高，檢查 Down
    if (downPrice < config.MAX_BUY_PRICE) {
      const downMomentum = this.calculateMomentum(downTokenId, downPrice);
      return {
        action: 'BUY',
        tokenId: downTokenId,
        outcome: 'Down',
        price: downPrice,
        size: config.MAX_POSITION_SIZE,
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
      if (tokenId === state.upTokenId) {
        position.currentPrice = state.upPrice;
      } else if (tokenId === state.downTokenId) {
        position.currentPrice = state.downPrice;
      } else if (tokenId === state.currentUpTokenId) {
        position.currentPrice = state.currentUpPrice;
      } else if (tokenId === state.currentDownTokenId) {
        position.currentPrice = state.currentDownPrice;
      }
    }
  }
}
