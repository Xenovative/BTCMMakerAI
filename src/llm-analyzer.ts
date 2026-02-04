import OpenAI from 'openai';
import { config } from './config.js';
import type { MarketState, OrderBook, Position } from './types.js';

/**
 * LLM 分析結果
 */
export interface LLMAnalysis {
  shouldTrade: boolean;
  recommendedOutcome: 'Up' | 'Down' | null;
  confidence: number; // 0-100
  recommendedSize: number;
  reasoning: string;
  marketSummary: string;
}

/**
 * LLM 市場分析器
 * 使用 OpenAI GPT 模型分析市場數據並做出交易決策
 */
export class LLMAnalyzer {
  private openai: OpenAI | null = null;
  private lastAnalysis: LLMAnalysis | null = null;
  // Cache disabled to avoid stale outputs
  private analysisCache: Map<string, { analysis: LLMAnalysis; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 0;

  constructor() {
    if (config.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: config.OPENAI_API_KEY,
      });
    }
  }

  /**
   * 檢查 LLM 是否可用
   */
  isAvailable(): boolean {
    return !!this.openai && !!config.OPENAI_API_KEY && config.LLM_ENABLED;
  }

  /**
   * 分析市場並給出交易建議
   */
  async analyze(
    state: MarketState,
    upOrderBook: OrderBook,
    downOrderBook: OrderBook,
    positions: Map<string, Position>
  ): Promise<LLMAnalysis> {
    if (!this.isAvailable()) {
      return this.getDefaultAnalysis('LLM 未啟用或 API Key 未設置');
    }

    try {
      const analysis = await this.callLLM(state, upOrderBook, downOrderBook, positions);
      this.lastAnalysis = analysis;
      return analysis;
    } catch (error: any) {
      console.error('[LLM] 分析失敗:', error?.message);
      return this.getDefaultAnalysis(`API 錯誤: ${error?.message}`);
    }
  }

  /**
   * 調用 LLM API
   */
  private async callLLM(
    state: MarketState,
    upOrderBook: OrderBook,
    downOrderBook: OrderBook,
    positions: Map<string, Position>
  ): Promise<LLMAnalysis> {
    if (!this.openai) {
      return this.getDefaultAnalysis('OpenAI 客戶端未初始化');
    }

    // 準備市場數據摘要
    const marketData = this.prepareMarketData(state, upOrderBook, downOrderBook, positions);

    console.log('[LLM][Input]\n' + marketData);

    const systemPrompt = `You are an expert cryptocurrency trading analyst specializing in short-term BTC price prediction markets.

Your task is to analyze market data and decide whether to trade in a 15-minute BTC Up/Down prediction market on Polymarket.

IMPORTANT RULES:
1. You can only BUY one side (Up or Down) before the market starts
2. The market resolves based on whether BTC price goes up or down in the next 15 minutes
3. You want to buy at a price below 50¢ and sell for profit before market starts, OR hold until resolution
4. Consider order book depth, price momentum, and market sentiment
5. Be conservative - only recommend trading when you have reasonable confidence
6. Position size should scale with confidence (20-100 shares)
7. Only trade when Up+Down price sum is below ${ (config.COMBINED_PRICE_CAP * 100).toFixed(0) }¢ (combined price cap)
8. Identify the current leader: whichever side has the higher price is favored to win; reflect this in reasoning and only go contrarian with strong evidence

Respond in JSON format ONLY:
{
  "shouldTrade": boolean,
  "recommendedOutcome": "Up" | "Down" | null,
  "confidence": number (0-100),
  "recommendedSize": number (20-100),
  "reasoning": "brief explanation",
  "marketSummary": "one line market condition summary"
}`;

    const userPrompt = `Analyze this market data and decide if we should trade:

${marketData}

Remember: Only recommend trading if you see a clear opportunity. Be specific about why you chose Up or Down.`;

    const response = await this.openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3, // 較低溫度以獲得更一致的結果
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return this.getDefaultAnalysis('LLM 返回空響應');
    }

    try {
      const parsed = JSON.parse(content);
      return this.validateAndNormalize(parsed);
    } catch (e) {
      console.error('[LLM] JSON 解析失敗:', content);
      return this.getDefaultAnalysis('JSON 解析失敗');
    }
  }

  /**
   * 準備市場數據摘要給 LLM
   */
  private prepareMarketData(
    state: MarketState,
    upOrderBook: OrderBook,
    downOrderBook: OrderBook,
    positions: Map<string, Position>
  ): string {
    const timeToStartSec = Math.round(state.timeToStart / 1000);
    const timeToEndSec = Math.round(state.timeToEnd / 1000);

    // 訂單簿摘要
    const upBidDepth = upOrderBook.bids.reduce((sum, b) => sum + b.size, 0);
    const upAskDepth = upOrderBook.asks.reduce((sum, a) => sum + a.size, 0);
    const downBidDepth = downOrderBook.bids.reduce((sum, b) => sum + b.size, 0);
    const downAskDepth = downOrderBook.asks.reduce((sum, a) => sum + a.size, 0);

    const upBestBid = upOrderBook.bids[0]?.price || 0;
    const upBestAsk = upOrderBook.asks[0]?.price || 0;
    const downBestBid = downOrderBook.bids[0]?.price || 0;
    const downBestAsk = downOrderBook.asks[0]?.price || 0;

    // 持倉狀態
    const hasPosition = positions.size > 0;
    const positionInfo = hasPosition
      ? Array.from(positions.values()).map(p => `${p.outcome}: ${p.size} shares @ ${p.avgBuyPrice.toFixed(1)}¢`).join(', ')
      : 'None';

    return `
=== MARKET STATUS ===
Current Market: ${state.currentMarket ? 'Active' : 'None'}
Next Market: ${state.nextMarket ? 'Pending' : 'None'}
Time to Next Market Start: ${timeToStartSec}s
Time to Current Market End: ${timeToEndSec}s

=== PRICES (in cents) ===
Up Price: ${state.upPrice.toFixed(2)}¢
Down Price: ${state.downPrice.toFixed(2)}¢
Price Sum: ${(state.upPrice + state.downPrice).toFixed(2)}¢ (should be ~100¢)
Combined Price Cap: ${(config.COMBINED_PRICE_CAP * 100).toFixed(0)}¢ (must be below to buy)
Leader: ${state.upPrice > state.downPrice ? 'Up' : state.downPrice > state.upPrice ? 'Down' : 'Tie'} (${Math.abs(state.upPrice - state.downPrice).toFixed(2)}¢ gap)

=== UP ORDER BOOK ===
Best Bid: ${(upBestBid * 100).toFixed(2)}¢ | Best Ask: ${(upBestAsk * 100).toFixed(2)}¢
Spread: ${((upBestAsk - upBestBid) * 100).toFixed(2)}¢
Total Bid Depth: ${upBidDepth.toFixed(0)} shares
Total Ask Depth: ${upAskDepth.toFixed(0)} shares
Imbalance: ${upBidDepth > upAskDepth ? 'More Buyers' : 'More Sellers'} (${((upBidDepth / (upBidDepth + upAskDepth || 1)) * 100).toFixed(0)}% bids)

=== DOWN ORDER BOOK ===
Best Bid: ${(downBestBid * 100).toFixed(2)}¢ | Best Ask: ${(downBestAsk * 100).toFixed(2)}¢
Spread: ${((downBestAsk - downBestBid) * 100).toFixed(2)}¢
Total Bid Depth: ${downBidDepth.toFixed(0)} shares
Total Ask Depth: ${downAskDepth.toFixed(0)} shares
Imbalance: ${downBidDepth > downAskDepth ? 'More Buyers' : 'More Sellers'} (${((downBidDepth / (downBidDepth + downAskDepth || 1)) * 100).toFixed(0)}% bids)

=== CURRENT POSITIONS ===
${positionInfo}

=== TRADING PARAMETERS ===
Max Buy Price: ${config.MAX_BUY_PRICE}¢
Profit Target: ${config.PROFIT_TARGET}¢
Stop Loss: ${config.STOP_LOSS}¢
Max Position Size: ${config.MAX_POSITION_SIZE} shares
Min Position Size: ${config.AI_MIN_POSITION_SIZE} shares
`.trim();
  }

  /**
   * 驗證並標準化 LLM 響應
   */
  private validateAndNormalize(parsed: any): LLMAnalysis {
    const shouldTrade = Boolean(parsed.shouldTrade);
    let recommendedOutcome: 'Up' | 'Down' | null = null;
    
    if (parsed.recommendedOutcome === 'Up' || parsed.recommendedOutcome === 'Down') {
      recommendedOutcome = parsed.recommendedOutcome;
    }

    const confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 0));
    
    // 根據信心度計算倉位大小
    let recommendedSize = Number(parsed.recommendedSize) || config.AI_MIN_POSITION_SIZE;
    recommendedSize = Math.max(config.AI_MIN_POSITION_SIZE, Math.min(config.MAX_POSITION_SIZE, recommendedSize));

    // 如果信心度低於門檻，不交易
    if (confidence < config.AI_MIN_CONFIDENCE) {
      return {
        shouldTrade: false,
        recommendedOutcome: null,
        confidence,
        recommendedSize: 0,
        reasoning: `信心度 ${confidence}% 低於門檻 ${config.AI_MIN_CONFIDENCE}%`,
        marketSummary: parsed.marketSummary || 'Low confidence',
      };
    }

    return {
      shouldTrade: shouldTrade && recommendedOutcome !== null,
      recommendedOutcome,
      confidence,
      recommendedSize: shouldTrade ? recommendedSize : 0,
      reasoning: String(parsed.reasoning || 'No reasoning provided'),
      marketSummary: String(parsed.marketSummary || 'No summary'),
    };
  }

  /**
   * 獲取默認分析結果（不交易）
   */
  private getDefaultAnalysis(reason: string): LLMAnalysis {
    return {
      shouldTrade: false,
      recommendedOutcome: null,
      confidence: 0,
      recommendedSize: 0,
      reasoning: reason,
      marketSummary: 'Analysis unavailable',
    };
  }

  /**
   * 獲取最近一次分析結果
   */
  getLastAnalysis(): LLMAnalysis | null {
    return this.lastAnalysis;
  }

  /**
   * 獲取分析摘要（用於日誌）
   */
  getAnalysisSummary(analysis: LLMAnalysis): string {
    if (!analysis.shouldTrade) {
      return `[LLM] 不建議交易 - ${analysis.reasoning}`;
    }

    return `[LLM] 建議買入 ${analysis.recommendedOutcome} x${analysis.recommendedSize} (信心: ${analysis.confidence}%) | ${analysis.reasoning}`;
  }
}

export const llmAnalyzer = new LLMAnalyzer();
