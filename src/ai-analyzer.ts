import { config } from './config.js';
import type { MarketState, OrderBook, Position, TradeRecord } from './types.js';

/**
 * AI 分析結果
 */
export interface AIAnalysis {
  shouldTrade: boolean;
  recommendedOutcome: 'Up' | 'Down' | null;
  confidence: number; // 0-100
  recommendedSize: number; // 根據信心調整的倉位大小
  reasons: string[];
  signals: {
    technical: TechnicalSignal;
    orderBook: OrderBookSignal;
    sentiment: SentimentSignal;
    timing: TimingSignal;
  };
}

interface TechnicalSignal {
  momentum: number; // -100 to 100
  volatility: number; // 0-100
  rsi: number; // 0-100
  trend: 'bullish' | 'bearish' | 'neutral';
  score: number; // -100 to 100
}

interface OrderBookSignal {
  bidAskSpread: number; // cents
  depthImbalance: number; // -1 to 1 (positive = more bids)
  liquidityScore: number; // 0-100
  score: number; // -100 to 100
}

interface SentimentSignal {
  priceDeviation: number; // 偏離 50¢ 的程度
  recentWinRate: number; // 最近交易勝率
  marketBias: 'Up' | 'Down' | 'neutral';
  score: number; // -100 to 100
}

interface TimingSignal {
  timeToStart: number; // ms
  optimalWindow: boolean; // 是否在最佳交易窗口
  urgency: number; // 0-100
  score: number; // -100 to 100
}

/**
 * AI 市場分析器
 * 
 * 使用多種分析方法來決定：
 * 1. 是否應該交易
 * 2. 買入哪個方向 (Up/Down)
 * 3. 買入多少（根據信心調整倉位）
 */
export class AIAnalyzer {
  private priceHistory: Map<string, number[]> = new Map();
  private readonly HISTORY_LENGTH = 120; // 保留更多歷史數據
  private tradeHistory: TradeRecord[] = [];

  /**
   * 更新交易歷史（用於計算勝率）
   */
  updateTradeHistory(history: TradeRecord[]): void {
    this.tradeHistory = history;
  }

  /**
   * 記錄價格歷史
   */
  recordPrice(tokenId: string, price: number): void {
    const history = this.priceHistory.get(tokenId) || [];
    history.push(price);
    if (history.length > this.HISTORY_LENGTH) {
      history.shift();
    }
    this.priceHistory.set(tokenId, history);
  }

  /**
   * 取得訂單簿中間價
   */
  private getMidPrice(orderBook: OrderBook): number | null {
    const bestBid = orderBook.bids[0]?.price ?? null;
    const bestAsk = orderBook.asks[0]?.price ?? null;
    if (bestBid !== null && bestAsk !== null && bestAsk > 0) {
      return (bestBid + bestAsk) / 2;
    }
    if (bestBid !== null) return bestBid;
    if (bestAsk !== null) return bestAsk;
    return null;
  }

  /**
   * 主分析入口 - 分析市場並給出交易建議（同步版本）
   */
  analyzeSync(
    state: MarketState,
    upOrderBook: OrderBook,
    downOrderBook: OrderBook,
    positions: Map<string, Position>,
    livePrices?: Record<string, number>, // tokenId -> price in cents
    btcSpot?: number // BTC spot price (USDT)
  ): AIAnalysis {
    console.log('[AI][Input] upPrice=%d, downPrice=%d, timeToStart=%ds, timeToEnd=%ds',
      state.upPrice, state.downPrice, Math.round(state.timeToStart / 1000), Math.round(state.timeToEnd / 1000));
    console.log('[AI][OrderBook] up bids=%d asks=%d | down bids=%d asks=%d',
      upOrderBook.bids.length, upOrderBook.asks.length, downOrderBook.bids.length, downOrderBook.asks.length);
    console.log('[AI][Positions] count=%d', positions.size);

    // 實時價格：使用訂單簿中間價（若可用）
    const liveUp = livePrices?.[state.upTokenId];
    const liveDown = livePrices?.[state.downTokenId];
    const upMid = this.getMidPrice(upOrderBook);
    const downMid = this.getMidPrice(downOrderBook);
    const upPriceRt = liveUp ?? (upMid !== null ? upMid * 100 : state.upPrice);
    const downPriceRt = liveDown ?? (downMid !== null ? downMid * 100 : state.downPrice);
    console.log('[AI][RealTime] upMid=%.3f, downMid=%.3f (cents: %.2f / %.2f)', upMid, downMid, upPriceRt, downPriceRt);

    const reasons: string[] = [];

    // Combined price cap guard
    const combinedCents = upPriceRt + downPriceRt;
    if (combinedCents >= config.COMBINED_PRICE_CAP * 100) {
      reasons.push(`雙邊價格過高 up+down=${combinedCents.toFixed(1)}¢ >= cap ${(config.COMBINED_PRICE_CAP * 100).toFixed(0)}¢`);
      return {
        shouldTrade: false,
        recommendedOutcome: null,
        confidence: 0,
        recommendedSize: 0,
        reasons,
        signals: {
          technical: { momentum: 0, volatility: 0, rsi: 50, trend: 'neutral', score: 0 },
          orderBook: { bidAskSpread: 0, depthImbalance: 0, liquidityScore: 0, score: 0 },
          sentiment: { priceDeviation: 0, recentWinRate: 50, marketBias: 'neutral', score: 0 },
          timing: { timeToStart: Math.round(state.timeToStart / 1000), optimalWindow: false, urgency: 0, score: 0 },
        },
      };
    }

    // 記錄當前價格
    if (state.upTokenId) this.recordPrice(state.upTokenId, upPriceRt);
    if (state.downTokenId) this.recordPrice(state.downTokenId, downPriceRt);
    if (btcSpot != null) this.recordPrice('BTC_SPOT', btcSpot);

    const btcMomentum = this.calculateMomentumFromHistory('BTC_SPOT');

    // 1. 技術分析
    const technicalUp = this.analyzeTechnical(state.upTokenId, upPriceRt);
    const technicalDown = this.analyzeTechnical(state.downTokenId, downPriceRt);

    // 2. 訂單簿分析
    const orderBookUp = this.analyzeOrderBook(upOrderBook, upPriceRt);
    const orderBookDown = this.analyzeOrderBook(downOrderBook, downPriceRt);

    // 3. 情緒分析
    const sentimentUp = this.analyzeSentiment(upPriceRt, 'Up', btcMomentum);
    const sentimentDown = this.analyzeSentiment(downPriceRt, 'Down', btcMomentum);

    // 3b. 最近盤結果偏好
    const prev = state.previousOutcomes || [];
    if (prev.length > 0) {
      const window = prev.slice(-5);
      const upWins = window.filter(o => o === 'Up').length;
      const downWins = window.filter(o => o === 'Down').length;
      const bias = (upWins - downWins) / window.length; // -1..1
      if (bias > 0) {
        sentimentUp.score += 8 * bias;
        sentimentDown.score -= 5 * bias;
        reasons.push(`近期盤勢偏向 Up (${upWins}/${window.length}), 加分 Up`);
      } else if (bias < 0) {
        sentimentDown.score += -8 * bias;
        sentimentUp.score -= -5 * bias;
        reasons.push(`近期盤勢偏向 Down (${downWins}/${window.length}), 加分 Down`);
      } else {
        reasons.push('近期盤勢無明顯偏向');
      }
    }

    // 4. 時機分析
    const timing = this.analyzeTiming(state);

    // 5. 綜合評分
    const upScore = this.calculateCompositeScore(technicalUp, orderBookUp, sentimentUp, timing);
    const downScore = this.calculateCompositeScore(technicalDown, orderBookDown, sentimentDown, timing);

    // 6. 決策邏輯
    const { shouldTrade, recommendedOutcome, confidence, recommendedSize } = this.makeDecision(
      state,
      upScore,
      downScore,
      technicalUp,
      technicalDown,
      orderBookUp,
      orderBookDown,
      timing,
      positions,
      reasons
    );

    // 選擇推薦方向的信號
    const isUp = recommendedOutcome === 'Up';
    
    return {
      shouldTrade,
      recommendedOutcome,
      confidence,
      recommendedSize,
      reasons,
      signals: {
        technical: isUp ? technicalUp : technicalDown,
        orderBook: isUp ? orderBookUp : orderBookDown,
        sentiment: isUp ? sentimentUp : sentimentDown,
        timing,
      },
    };
  }

  /**
   * 技術分析
   */
  private analyzeTechnical(tokenId: string, currentPrice: number): TechnicalSignal {
    const history = this.priceHistory.get(tokenId) || [];
    
    // 動量計算 (短期 vs 長期均價)
    let momentum = 0;
    if (history.length >= 10) {
      const shortMA = this.calculateMA(history, 5);
      const longMA = this.calculateMA(history, 20);
      momentum = ((shortMA - longMA) / longMA) * 100 * 10; // 放大差異
      momentum = Math.max(-100, Math.min(100, momentum));
    }

    // 波動率計算
    let volatility = 0;
    if (history.length >= 10) {
      const stdDev = this.calculateStdDev(history.slice(-10));
      volatility = Math.min(100, stdDev * 10); // 標準化
    }

    // RSI 計算
    const rsi = this.calculateRSI(history);

    // 趨勢判斷
    let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (momentum > 20 && rsi > 50) trend = 'bullish';
    else if (momentum < -20 && rsi < 50) trend = 'bearish';

    // 綜合技術分數
    // 正動量 + RSI 超賣 = 買入信號
    // 低波動率 = 更可預測
    let score = 0;
    
    // RSI 信號: 超賣(<30)買入機會, 超買(>70)風險
    if (rsi < 30) score += 30;
    else if (rsi < 40) score += 15;
    else if (rsi > 70) score -= 30;
    else if (rsi > 60) score -= 15;

    // 動量信號
    score += momentum * 0.3;

    // 波動率懲罰（高波動 = 高風險）
    if (volatility > 50) score -= 20;
    else if (volatility > 30) score -= 10;

    return {
      momentum,
      volatility,
      rsi,
      trend,
      score: Math.max(-100, Math.min(100, score)),
    };
  }

  /**
   * 訂單簿分析
   */
  private analyzeOrderBook(orderBook: OrderBook, currentPrice: number): OrderBookSignal {
    const { bids, asks } = orderBook;

    // Bid-Ask Spread
    const bestBid = bids.length > 0 ? bids[0].price * 100 : currentPrice - 1;
    const bestAsk = asks.length > 0 ? asks[0].price * 100 : currentPrice + 1;
    const bidAskSpread = bestAsk - bestBid;

    // 深度不平衡 (正數 = 買盤強)
    const totalBidSize = bids.reduce((sum, b) => sum + b.size, 0);
    const totalAskSize = asks.reduce((sum, a) => sum + a.size, 0);
    const totalSize = totalBidSize + totalAskSize;
    const depthImbalance = totalSize > 0 ? (totalBidSize - totalAskSize) / totalSize : 0;

    // 流動性評分
    const liquidityScore = Math.min(100, totalSize / config.MIN_ORDERBOOK_DEPTH * 50);

    // 綜合訂單簿分數
    let score = 0;

    // 深度不平衡信號
    score += depthImbalance * 50; // 買盤強 = 正分

    // 流動性獎勵
    if (liquidityScore > 80) score += 15;
    else if (liquidityScore > 50) score += 8;
    else if (liquidityScore < 30) score -= 15; // 放寬流動性懲罰

    // 點差懲罰
    const clampedSpread = Math.min(bidAskSpread, 50); // 夾住極端點差
    if (clampedSpread > 10) score -= 12;
    else if (clampedSpread > 5) score -= 8;
    else if (clampedSpread < 2) score += 8;

    return {
      bidAskSpread,
      depthImbalance,
      liquidityScore,
      score: Math.max(-100, Math.min(100, score)),
    };
  }

  /**
   * 情緒分析
   */
  private analyzeSentiment(price: number, outcome: 'Up' | 'Down', btcMomentum?: number): SentimentSignal {
    // 價格偏離 50¢ 的程度
    const priceDeviation = price - 50;

    // 計算最近交易勝率
    const recentTrades = this.tradeHistory.slice(-20);
    const wins = recentTrades.filter(t => (t.pnl || 0) > 0).length;
    const recentWinRate = recentTrades.length > 0 ? (wins / recentTrades.length) * 100 : 50;

    // 市場偏向
    let marketBias: 'Up' | 'Down' | 'neutral' = 'neutral';
    if (priceDeviation > 10) marketBias = outcome === 'Up' ? 'Up' : 'Down';
    else if (priceDeviation < -10) marketBias = outcome === 'Up' ? 'Down' : 'Up';

    // 綜合情緒分數
    let score = 0;

    // 價格偏離信號 - 價格低於 50¢ = 買入機會
    if (price < 40) score += 40;
    else if (price < 45) score += 25;
    else if (price < 50) score += 10;
    else if (price > 55) score -= 20; // 價格過高風險
    else if (price > 60) score -= 40;

    // 勝率調整
    if (recentWinRate > 60) score += 15;
    else if (recentWinRate < 40) score -= 15;

    // BTC 動能偏好 (正動能偏向 Up, 負動能偏向 Down)
    if (btcMomentum != null) {
      if (btcMomentum > 0.2) {
        score += outcome === 'Up' ? 12 : -8;
      } else if (btcMomentum < -0.2) {
        score += outcome === 'Down' ? 12 : -8;
      }
    }

    return {
      priceDeviation,
      recentWinRate,
      marketBias,
      score: Math.max(-100, Math.min(100, score)),
    };
  }

  /**
   * 時機分析
   */
  private analyzeTiming(state: MarketState): TimingSignal {
    const timeToStart = state.timeToStart;
    
    // 最佳交易窗口: 開盤前 30秒 到 5分鐘
    const optimalWindow = timeToStart > config.MIN_TIME_TO_TRADE_MS && timeToStart < 5 * 60 * 1000;

    // 緊迫度
    let urgency = 0;
    if (timeToStart < 30000) urgency = 100; // 太緊迫
    else if (timeToStart < 60000) urgency = 70;
    else if (timeToStart < 2 * 60000) urgency = 40;
    else urgency = 20;

    // 時機分數
    let score = 0;
    
    if (optimalWindow) {
      score += 30;
      // 越接近開盤，分數越高（但不能太近）
      if (timeToStart < 2 * 60000 && timeToStart > 30000) score += 20;
    } else if (timeToStart <= config.MIN_TIME_TO_TRADE_MS) {
      score -= 100; // 太近了，不能交易
    } else if (timeToStart > 10 * 60 * 1000) {
      score -= 30; // 太遠了，價格可能變化
    }

    return {
      timeToStart,
      optimalWindow,
      urgency,
      score: Math.max(-100, Math.min(100, score)),
    };
  }

  /**
   * 計算綜合評分
   */
  private calculateCompositeScore(
    technical: TechnicalSignal,
    orderBook: OrderBookSignal,
    sentiment: SentimentSignal,
    timing: TimingSignal
  ): number {
    // 加權平均
    const weights = {
      technical: 0.25,
      orderBook: 0.30, // 訂單簿最重要
      sentiment: 0.25,
      timing: 0.20,
    };

    return (
      technical.score * weights.technical +
      orderBook.score * weights.orderBook +
      sentiment.score * weights.sentiment +
      timing.score * weights.timing
    );
  }

  /**
   * 做出交易決策
   */
  private makeDecision(
    state: MarketState,
    upScore: number,
    downScore: number,
    technicalUp: TechnicalSignal,
    technicalDown: TechnicalSignal,
    orderBookUp: OrderBookSignal,
    orderBookDown: OrderBookSignal,
    timing: TimingSignal,
    positions: Map<string, Position>,
    reasons: string[]
  ): {
    shouldTrade: boolean;
    recommendedOutcome: 'Up' | 'Down' | null;
    confidence: number;
    recommendedSize: number;
  } {
    // 選擇較好的方向
    const bestOutcome: 'Up' | 'Down' = upScore > downScore ? 'Up' : 'Down';
    const bestScore = Math.max(upScore, downScore);
    const bestPrice = bestOutcome === 'Up' ? state.upPrice : state.downPrice;
    const bestOrderBook = bestOutcome === 'Up' ? orderBookUp : orderBookDown;
    const bestTechnical = bestOutcome === 'Up' ? technicalUp : technicalDown;

    // 計算信心度 (0-100)
    // 基於分數、價格優勢、流動性（更積極）
    let confidence = 60; // 提高基礎信心
    
    // 分數貢獻（加大權重）
    confidence += bestScore * 0.6;
    
    // 價格優勢 (越低越好)
    if (bestPrice < 40) confidence += 20;
    else if (bestPrice < 45) confidence += 12;
    else if (bestPrice > 48) confidence -= 6;

    // 流動性貢獻
    if (bestOrderBook.liquidityScore > 80) confidence += 10;
    else if (bestOrderBook.liquidityScore < 50) confidence -= 5;

    // 技術面貢獻
    if (bestTechnical.trend === 'bullish') confidence += 8;
    else if (bestTechnical.trend === 'bearish') confidence -= 8;

    confidence = Math.max(0, Math.min(100, confidence));

    // 根據信心度計算倉位大小
    const sizeMultiplier = confidence / 100;
    const recommendedSize = Math.max(
      config.AI_MIN_POSITION_SIZE,
      Math.floor(config.MAX_POSITION_SIZE * sizeMultiplier)
    );

    // 記錄決策原因
    reasons.push(`選擇 ${bestOutcome}: score=${bestScore.toFixed(1)}, confidence=${confidence.toFixed(0)}%`);
    reasons.push(`技術: momentum=${bestTechnical.momentum.toFixed(1)}, RSI=${bestTechnical.rsi.toFixed(0)}, trend=${bestTechnical.trend}`);
    reasons.push(`訂單簿: spread=${bestOrderBook.bidAskSpread.toFixed(2)}¢, imbalance=${(bestOrderBook.depthImbalance * 100).toFixed(0)}%, liquidity=${bestOrderBook.liquidityScore.toFixed(0)}`);
    reasons.push(`建議倉位: ${recommendedSize} 股 (${(sizeMultiplier * 100).toFixed(0)}% of max)`);

    return {
      shouldTrade: true,
      recommendedOutcome: bestOutcome,
      confidence,
      recommendedSize,
    };
  }

  // ==================== 輔助計算函數 ====================

  /**
   * 計算移動平均
   */
  private calculateMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 50;
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  /**
   * 計算標準差
   */
  private calculateStdDev(prices: number[]): number {
    if (prices.length < 2) return 0;
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const squaredDiffs = prices.map(p => Math.pow(p - mean, 2));
    return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / prices.length);
  }

  /**
   * 計算 RSI (Relative Strength Index)
   */
  private calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50; // 默認中性

    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    const recentChanges = changes.slice(-period);
    let gains = 0;
    let losses = 0;

    for (const change of recentChanges) {
      if (change > 0) gains += change;
      else losses -= change;
    }

    if (losses === 0) return 100;
    if (gains === 0) return 0;

    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }

  /**
   * 計算動能（通用）
   */
  private calculateMomentumFromHistory(tokenId: string, short: number = 3, long: number = 10): number {
    const history = this.priceHistory.get(tokenId) || [];
    if (history.length < long) return 0;

    const shortMA = this.calculateMA(history, short);
    const longMA = this.calculateMA(history, long);
    const momentum = ((shortMA - longMA) / longMA) * 100;
    return Math.max(-100, Math.min(100, momentum));
  }

  /**
   * 獲取分析摘要（用於日誌）
   */
  getAnalysisSummary(analysis: AIAnalysis): string {
    const { shouldTrade, recommendedOutcome, confidence, recommendedSize, signals } = analysis;
    
    if (!shouldTrade) {
      return `[AI] 不建議交易 - ${analysis.reasons[0] || 'unknown'}`;
    }

    return `[AI] 建議買入 ${recommendedOutcome} x${recommendedSize} (信心: ${confidence.toFixed(0)}%) | ` +
      `技術=${signals.technical.score.toFixed(0)}, 訂單簿=${signals.orderBook.score.toFixed(0)}, ` +
      `情緒=${signals.sentiment.score.toFixed(0)}, 時機=${signals.timing.score.toFixed(0)}`;
  }
}

export const aiAnalyzer = new AIAnalyzer();
