import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import fs from 'fs/promises';
import path from 'path';
import { Wallet } from 'ethers';
import { getAddress } from 'ethers/lib/utils.js';
import { config } from './config.js';
import type { Position, TradeRecord } from './types.js';

const CLOB_HTTP_URL = config.CLOB_HOST;
const CHAIN_ID = config.CHAIN_ID;
const POS_CACHE_PATH = path.join(process.cwd(), 'positions-cache.json');

export interface ApiCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export class Trader {
  private clobClient: ClobClient | null = null;
  private apiCredentials: ApiCredentials | null = null;
  private positions: Map<string, Position> = new Map();
  private tradeHistory: TradeRecord[] = [];
  private pendingSellOrders: Map<string, string> = new Map(); // tokenId -> orderId
  private pendingBuyOrders: Map<string, { orderId: string; outcome: 'Up' | 'Down' }> = new Map();
  private bracketOrdersPlaced: Set<string> = new Set(); // tokenIds that already got TP/SL orders
  private stopLossWatch: Map<string, { outcome: 'Up' | 'Down'; price: number }> = new Map();
  private cachedAvgPrices: Map<string, number> = new Map();

  // 檢查止損監視（用市價兜底）
  async checkStopLossWatch(prices: Record<string, number>): Promise<void> {
    for (const [tokenId, watch] of this.stopLossWatch.entries()) {
      const price = prices[tokenId];
      if (price == null) continue;
      const priceCents = price;
      if (priceCents <= watch.price) {
        console.warn('[StopWatch] 觸發市價止損 token=%s price=%.2f¢ threshold=%.2f¢', tokenId, priceCents, watch.price);
        await this.forceLiquidate(tokenId, watch.outcome, priceCents);
        this.stopLossWatch.delete(tokenId);
      }
    }
  }

  async initialize(): Promise<boolean> {
    if (config.PAPER_TRADING) {
      console.log('🧪 Paper trading mode - no real trades will be executed');
      return true;
    }

    await this.loadPriceCache();

    if (!config.PRIVATE_KEY) {
      console.error('[交易] 未配置私鑰');
      return false;
    }

    try {
      const signer = new Wallet(config.PRIVATE_KEY);

      // 創建 L1 客戶端以獲取 API 憑證
      const l1Client = new ClobClient(CLOB_HTTP_URL, CHAIN_ID, signer);

      console.log('[交易] 正在從私鑰衍生 API 憑證...');
      const creds = await l1Client.createOrDeriveApiKey();

      this.apiCredentials = {
        apiKey: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };

      console.log(`[交易] API 憑證已獲取: ${this.apiCredentials.apiKey.slice(0, 8)}...`);

      // 創建 L2 客戶端用於交易
      if (config.FUNDER_ADDRESS) {
        // Proxy wallet 模式 (signatureType=1)
        console.log(`[交易] 使用 Proxy Wallet: ${config.FUNDER_ADDRESS}`);
        this.clobClient = new ClobClient(
          CLOB_HTTP_URL,
          CHAIN_ID,
          signer,
          creds,
          1, // signatureType 1 = Polymarket proxy wallet
          config.FUNDER_ADDRESS
        );
      } else {
        // EOA 模式 (signatureType=0)
        console.log(`[交易] 使用 EOA Wallet: ${signer.address}`);
        this.clobClient = new ClobClient(
          CLOB_HTTP_URL,
          CHAIN_ID,
          signer,
          creds
        );
      }

      console.log('✅ 交易客戶端已初始化');
      return true;
    } catch (err) {
      console.error('[交易] 初始化失敗:', err);
      return false;
    }
  }

  /**
   * 從 API 同步實際持倉到內存
   */
  async syncPositionsFromApi(upTokenId: string, downTokenId: string, upPrice: number, downPrice: number): Promise<void> {
    if (config.PAPER_TRADING || !this.clobClient) {
      return;
    }

    try {
      // 查詢 Up 持倉
      const upBalances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: upTokenId });
      const upBalance = parseFloat(upBalances?.balance || '0') / 1e6;
      
      if (upBalance >= 0.001) {
        if (!this.positions.has(upTokenId)) {
          const lastBuy = [...this.tradeHistory].reverse().find((t) => t.side === 'BUY' && t.price != null && t.tokenId === upTokenId);
          const cached = this.cachedAvgPrices.get(upTokenId);
          const seedPrice = cached ?? lastBuy?.price ?? upPrice;
          console.log(`[同步] 發現 Up 持倉: ${upBalance.toFixed(3)} 股 (估計買入價: ${seedPrice.toFixed(1)}¢)`);
          this.positions.set(upTokenId, {
            tokenId: upTokenId,
            outcome: 'Up',
            size: upBalance,
            avgBuyPrice: seedPrice,
            currentPrice: upPrice,
          });
          this.cachedAvgPrices.set(upTokenId, seedPrice);
          void this.savePriceCache();
        } else {
          // 已有持倉記錄 - 只更新數量和現價，保留原始 avgBuyPrice
          const pos = this.positions.get(upTokenId)!;
          pos.size = upBalance;
          pos.currentPrice = upPrice;
        }
      } else if (this.positions.has(upTokenId)) {
        // Only clear when effectively zero to avoid thrashing avgBuyPrice
        if (upBalance < 0.0001) {
          console.log(`[同步] Up 持倉已清空 (on-chain ${upBalance.toFixed(6)})`);
          this.positions.delete(upTokenId);
          this.pendingSellOrders.delete(upTokenId);
          this.bracketOrdersPlaced.delete(upTokenId);
          this.stopLossWatch.delete(upTokenId);
          this.cachedAvgPrices.delete(upTokenId);
          void this.savePriceCache();
        }
      }

      // 查詢 Down 持倉
      const downBalances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: downTokenId });
      const downBalance = parseFloat(downBalances?.balance || '0') / 1e6;
      
      if (downBalance >= 0.001) {
        if (!this.positions.has(downTokenId)) {
          const lastBuy = [...this.tradeHistory].reverse().find((t) => t.side === 'BUY' && t.price != null && t.tokenId === downTokenId);
          const cached = this.cachedAvgPrices.get(downTokenId);
          const seedPrice = cached ?? lastBuy?.price ?? downPrice;
          console.log(`[同步] 發現 Down 持倉: ${downBalance.toFixed(3)} 股 (估計買入價: ${seedPrice.toFixed(1)}¢)`);
          this.positions.set(downTokenId, {
            tokenId: downTokenId,
            outcome: 'Down',
            size: downBalance,
            avgBuyPrice: seedPrice,
            currentPrice: downPrice,
          });
          this.cachedAvgPrices.set(downTokenId, seedPrice);
          void this.savePriceCache();
        } else {
          const pos = this.positions.get(downTokenId)!;
          pos.size = downBalance;
          pos.currentPrice = downPrice;
        }
      } else if (this.positions.has(downTokenId)) {
        if (downBalance < 0.0001) {
          console.log(`[同步] Down 持倉已清空 (on-chain ${downBalance.toFixed(6)})`);
          this.positions.delete(downTokenId);
          this.pendingSellOrders.delete(downTokenId);
          this.bracketOrdersPlaced.delete(downTokenId);
          this.stopLossWatch.delete(downTokenId);
          this.cachedAvgPrices.delete(downTokenId);
          void this.savePriceCache();
        }
      }
    } catch (error: any) {
      console.error('[同步] 查詢持倉失敗:', error?.message);
    }
  }

  /**
   * 為現有持倉補掛 Limit Sell 訂單
   */
  async placeLimitSellForPosition(
    tokenId: string,
    outcome: 'Up' | 'Down',
    buyPrice: number,
    currentPrice: number
  ): Promise<boolean> {
    if (config.PAPER_TRADING || !this.clobClient) {
      return false;
    }

    // 檢查是否已有掛單（必須有有效的 orderId）
    const existingOrder = this.pendingSellOrders.get(tokenId);
    if (existingOrder && existingOrder.length > 0) {
      if (existingOrder === 'under-min-size') {
        console.log(`[Limit Sell] 清除殘留 under-min 標記，停止重試 dust 倉位`);
        this.positions.delete(tokenId);
        this.pendingSellOrders.delete(tokenId);
        return true;
      }
      // 檢查該掛單是否仍然存在或已成交/取消
      try {
        const orderInfo: any = await this.clobClient?.getOrder(existingOrder);
        const status = orderInfo?.status || orderInfo?.state || '';
        const filled = parseFloat(orderInfo?.averagePrice ?? orderInfo?.average_price ?? '0');
        const sizeFilled = parseFloat(orderInfo?.sizeFilled ?? orderInfo?.size_filled ?? orderInfo?.filled ?? orderInfo?.filledSize ?? orderInfo?.totalFilled ?? orderInfo?.size_filled_total ?? '0');
        if (status && status.toLowerCase() === 'filled') {
          console.log(`[Limit Sell] 掛單 ${existingOrder} 已成交，清除 pending`);
          this.pendingSellOrders.delete(tokenId);
          // 同步一次持倉數量（根據 on-chain balance）
          try {
            const balances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
            const rawBalance = parseFloat(balances?.balance || '0') / 1e6;
            const pos = this.positions.get(tokenId);
            if (pos) pos.size = rawBalance;
          } catch {}
          return true;
        }
        // 若無法取得訂單或狀態非開放，清除 pending 讓後續重新掛單
        if (!orderInfo || status.toLowerCase() === 'cancelled' || status.toLowerCase() === 'canceled') {
          console.log(`[Limit Sell] 掛單 ${existingOrder} 不存在或已取消，清除 pending 重試`);
          this.pendingSellOrders.delete(tokenId);
        } else {
          console.log(`[Limit Sell] 已有掛單: ${existingOrder} status=${status} filled=${sizeFilled} avg=${filled}`);
          return true;
        }
      } catch (e: any) {
        console.log(`[Limit Sell] 查詢掛單失敗，清除 pending 以允許重掛: ${e?.message}`);
        this.pendingSellOrders.delete(tokenId);
      }
    }

    try {
      // 查詢可用餘額（allowance = 可賣數量，balance = 總持倉）
      const balances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
      if (!balances) {
        console.log(`[Limit Sell] 無法查詢持倉`);
        return false;
      }

      const rawBalance = parseFloat(balances.balance || '0') / 1e6;
      let rawAllowance = parseFloat(balances.allowance || '0') / 1e6;
      
      console.log(`[Limit Sell] balance=${rawBalance.toFixed(4)}, allowance=${rawAllowance.toFixed(4)}`);

      // 查詢是否有該 token 的 open sell order，若有則標記並退出，避免重複掛單
      try {
        const openOrders = await this.clobClient.getOpenOrders({ asset_id: tokenId });
        const sellOrders = openOrders?.filter((o: any) => o.side === 'SELL') || [];
        if (sellOrders.length > 0) {
          console.log(`[Limit Sell] 已有 ${sellOrders.length} 個賣單掛單中`);
          this.pendingSellOrders.set(tokenId, sellOrders[0].id || 'existing');
          return true;
        }
      } catch (e: any) {
        console.log(`[Limit Sell] 查詢掛單失敗: ${e?.message}`);
      }

      // 如果 allowance=0 但 balance>0，嘗試 approve 一次
      if (rawAllowance < 0.1 && rawBalance > 0.1) {
        console.log(`[Limit Sell] allowance 為 0，嘗試 approve token...`);
        try {
          await this.clobClient.updateBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
          await this.sleep(2000);
          const newBalances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
          rawAllowance = parseFloat(newBalances?.allowance || '0') / 1e6;
          console.log(`[Limit Sell] Approve 後 allowance=${rawAllowance.toFixed(4)}`);
        } catch (e: any) {
          console.log(`[Limit Sell] approve 或重查失敗: ${e?.message}`);
        }

        if (rawAllowance < 0.1) {
          // 還是 0，直接用 balance 嘗試
          rawAllowance = rawBalance;
        }
      }
      
      // 決定實際可賣數量：使用 balance（向下取一位小數），allowance 只用來批准
      const actualSize = rawBalance > 0.05 ? Math.floor(rawBalance * 10) / 10 : 0;
      if (actualSize <= 0) {
        console.warn(`[Limit Sell] 可賣數量為 0，跳過`);
        // 清除殘留標記，避免反覆重試
        this.positions.delete(tokenId);
        this.pendingSellOrders.delete(tokenId);
        return false;
      }
      if (actualSize < 5) {
        console.warn(`[Limit Sell] 可賣數量 ${actualSize.toFixed(1)} < 5 (交易所最小值)，改用市價清理一次`);
        const cleaned = await this.marketSellRemainder(tokenId, outcome, currentPrice, 'under-min');
        if (!cleaned) {
          // 如果清理失敗，仍然把本地持倉/掛單清掉，避免無限重試
          this.positions.delete(tokenId);
          this.pendingSellOrders.delete(tokenId);
        } else {
          this.pendingSellOrders.delete(tokenId);
        }
        return false;
      }

      const targetSellPrice = buyPrice * (1 + config.PROFIT_TARGET_PCT);
      const targetSellPriceDecimal = targetSellPrice / 100;

      console.log(`📊 補掛 Limit Sell: ${actualSize} 股 ${outcome} @ ${targetSellPriceDecimal.toFixed(2)} (+${(config.PROFIT_TARGET_PCT * 100).toFixed(2)}%) [raw balance: ${rawBalance}]`);

      const sellResponse = await this.clobClient.createAndPostOrder({
        tokenID: tokenId,
        price: targetSellPriceDecimal,
        size: actualSize,
        side: Side.SELL,
      });

      console.log(`📌 LIMIT SELL order placed: ${sellResponse.orderID} @ ${targetSellPriceDecimal.toFixed(2)} x ${actualSize}`);
      this.pendingSellOrders.set(tokenId, sellResponse.orderID || '');
      return true;
    } catch (error: any) {
      console.error('[Limit Sell] 補掛失敗:', error?.message || error);
      return false;
    }
  }

  /**
   * 用 Market Sell 清掉剩餘小數股份
   */
  async marketSellRemainder(
    tokenId: string,
    outcome: 'Up' | 'Down',
    currentPrice: number,
    reason: string = 'remainder'
  ): Promise<boolean> {
    if (config.PAPER_TRADING || !this.clobClient) {
      return false;
    }

    try {
      const balances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
      if (!balances) return false;

      const rawBalance = parseFloat(balances.balance || '0') / 1e6;
      let rawAllowance = parseFloat(balances.allowance || '0') / 1e6;

      // fallback to balance if allowance is empty
      if (rawAllowance < 0.01 && rawBalance > 0.01) {
        rawAllowance = rawBalance;
      }

      // 只處理小於 1 股的剩餘（小數部分）
      if (rawAllowance <= 0 || rawAllowance >= 1) {
        return false;
      }

      const sellSize = parseFloat(rawAllowance.toFixed(2));
      if (sellSize <= 0) {
        this.positions.delete(tokenId);
        this.pendingSellOrders.delete(tokenId);
        return false;
      }

      // Market Sell: 用較低價格確保成交
      const marketPrice = Math.max((currentPrice - 5) / 100, 0.01); // 當前價 -5¢

      console.log(`🧹 Market Sell (${reason}) 清理: ${sellSize} 股 ${outcome} @ ${marketPrice.toFixed(2)}`);

      const sellResponse = await this.clobClient.createAndPostOrder({
        tokenID: tokenId,
        price: marketPrice,
        size: sellSize,
        side: Side.SELL,
      });

      console.log(`✅ Market Sell 完成: ${sellResponse.orderID}`);
      const pos = this.positions.get(tokenId);
      const pnl = pos ? (currentPrice - pos.avgBuyPrice) * sellSize : 0;
      const costCents = pos ? pos.avgBuyPrice * sellSize : undefined;
      this.recordTrade(tokenId, outcome, 'SELL', currentPrice, sellSize, pnl, costCents, tokenId);
      this.updatePosition(tokenId, outcome, -sellSize, currentPrice);
      // 清除 pending，避免對同一殘餘倉位重複嘗試
      this.pendingSellOrders.delete(tokenId);
      return true;
    } catch (error: any) {
      console.error('[Market Sell] 失敗:', error?.message || error);
      this.positions.delete(tokenId);
      this.pendingSellOrders.delete(tokenId);
      return false;
    }
  }

  /**
   * 買入指定 outcome，成功後立即掛 Limit Sell 訂單
   */
  async buy(
    tokenId: string,
    outcome: 'Up' | 'Down',
    price: number,
    size: number
  ): Promise<boolean> {
    // Avoid switching sides while any buy order is still open
    for (const [pendingToken, pending] of Array.from(this.pendingBuyOrders.entries())) {
      if (pending.outcome !== outcome) {
        try {
          const info: any = await this.clobClient?.getOrder(pending.orderId);
          const status = info?.status || info?.state || '';
          if (status && status.toLowerCase() === 'open') {
            console.log(`[BUY] Skip because pending buy order ${pending.orderId} (${pending.outcome}) still open`);
            return false;
          }
          // Clean up if filled/canceled
          this.pendingBuyOrders.delete(pendingToken);
        } catch (e: any) {
          console.log(`[BUY] Pending buy check failed, skip to avoid side flip: ${e?.message}`);
          return false;
        }
      }
    }

    // 單邊持倉防護：若持有相反方向的任何倉位則不買
    for (const pos of this.positions.values()) {
      if (pos.size > 0 && pos.outcome !== outcome) {
        console.log(`[BUY] 已持有相反倉位 ${pos.size.toFixed(3)} ${pos.outcome}，先清空後再買 ${outcome}`);
        return false;
      }
    }

    const priceDecimal = price / 100;
    const targetSellPrice = price + config.PROFIT_TARGET; // 買入價 + 差距值
    const targetSellPriceDecimal = targetSellPrice / 100;

    if (config.PAPER_TRADING) {
      console.log(`📝 [PAPER] BUY ${size} ${outcome} @ ${priceDecimal.toFixed(2)}`);
      console.log(`📝 [PAPER] LIMIT SELL ${size} ${outcome} @ ${targetSellPriceDecimal.toFixed(2)} (target: +${config.PROFIT_TARGET}¢)`);
      this.updatePosition(tokenId, outcome, size, price);
      this.recordTrade(tokenId, outcome, 'BUY', price, size, undefined, undefined, tokenId);
      this.pendingSellOrders.set(tokenId, `paper-${Date.now()}`);
      return true;
    }

    if (!this.clobClient) {
      console.error('Trading client not initialized');
      return false;
    }

    try {
      // 如果已有開放中的 BUY 訂單，避免重複下單
      const openOrders = await this.clobClient.getOpenOrders({ asset_id: tokenId });
      const openBuys = openOrders?.filter((o: any) => o.side === 'BUY') || [];
      if (openBuys.length > 0) {
        console.log(`[BUY] 已有 ${openBuys.length} 筆 BUY 掛單，跳過重複下單`);
        return true;
      }

      // 1. 執行買入 (使用較高價格確保成交)
      const buyPrice = Math.min(priceDecimal + 0.01, 0.99); // 加 1¢ 確保成交
      const buyPriceCents = Math.round(buyPrice * 100);
      const buyResponse = await this.clobClient.createAndPostOrder({
        tokenID: tokenId,
        price: buyPrice,
        size,
        side: Side.BUY,
      });
      console.log(`✅ BUY order placed: ${buyResponse.orderID} @ ${buyPrice.toFixed(2)}`);
      this.pendingBuyOrders.set(tokenId, { orderId: buyResponse.orderID, outcome });
      // 嘗試獲取成交均價以與 Polymarket 顯示一致
      let executedPriceCents = buyPriceCents;
      try {
        for (let i = 0; i < 5; i++) {
          await this.sleep(400);
          const orderInfo: any = await this.clobClient.getOrder(buyResponse.orderID);
          const avg = orderInfo?.averagePrice ?? orderInfo?.average_price;
          if (avg) {
            executedPriceCents = Math.round(parseFloat(avg) * 100);
            console.log(`[BUY] 成交均價: ${executedPriceCents / 100} (from getOrder)`);
            break;
          }
        }
      } catch (e: any) {
        console.log(`[BUY] 讀取成交價失敗，使用提交價: ${e?.message}`);
      }

      // 2. 等待買單成交並輪詢確認
      console.log(`⏳ 等待買單成交...`);
      let actualSize = 0;
      let attempts = 0;
      const maxAttempts = 10; // 最多等 10 秒
      
      while (attempts < maxAttempts) {
        await this.sleep(1000);
        attempts++;
        
        try {
          const balances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
          const rawBalance = parseFloat(balances?.balance || '0') / 1e6;
          console.log(`📊 [${attempts}/${maxAttempts}] balance=${rawBalance.toFixed(2)}`);
          
          if (rawBalance >= size * 0.9) { // 至少 90% 成交
            // 確保有 allowance
            const rawAllowance = parseFloat(balances?.allowance || '0') / 1e6;
            if (rawAllowance < rawBalance * 0.9) {
              console.log(`🔓 Approving token for selling...`);
              await this.clobClient.updateBalanceAllowance({ 
                asset_type: 'CONDITIONAL' as any, 
                token_id: tokenId 
              });
              await this.sleep(500);
              const newBalances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
              actualSize = parseFloat((parseFloat(newBalances?.allowance || '0') / 1e6).toFixed(1));
            } else {
              actualSize = parseFloat(rawAllowance.toFixed(1));
            }
            console.log(`✅ 買單成交確認: ${actualSize} 股`);
            break;
          }
        } catch (e: any) {
          console.log(`⚠️ 查詢失敗: ${e?.message}`);
        }
      }

      if (actualSize <= 0) {
        console.log(`⚠️ 買單未成交或 allowance 為 0，撤回本地持倉記錄`);
        // 確保不留殘留持倉
        this.positions.delete(tokenId);
        this.pendingSellOrders.delete(tokenId);
        this.pendingBuyOrders.delete(tokenId);
        return true;
      }

      // 以實際成交均價與數量更新持倉並記錄交易
      this.updatePosition(tokenId, outcome, actualSize, executedPriceCents);
      this.recordTrade(tokenId, outcome, 'BUY', executedPriceCents, actualSize, undefined, undefined, tokenId);
      this.pendingBuyOrders.delete(tokenId);

      if (actualSize < 5) {
        console.warn(`[Limit Sell] 買單成交數量 ${actualSize} < 5，跳過掛單（交易所最小）`);
        return true;
      }

      // Immediately place TP limit sell at buy time
      await this.placeLimitSellForPosition(tokenId, outcome, executedPriceCents, executedPriceCents);
      return true;
    } catch (error: any) {
      console.error('Buy order failed:', error?.message || error);
      return false;
    }
  }

  /**
   * 強制清倉：取消所有掛單並用 Market Sell 賣出全部
   */
  async forceLiquidate(
    tokenId: string,
    outcome: 'Up' | 'Down',
    currentPrice: number
  ): Promise<boolean> {
    if (config.PAPER_TRADING) {
      console.log(`📝 [PAPER] FORCE LIQUIDATE ${outcome}`);
      const pos = this.positions.get(tokenId);
      if (pos && pos.size > 0) {
        const pnl = pos ? (currentPrice - pos.avgBuyPrice) * pos.size : 0;
        const costCents = pos ? pos.avgBuyPrice * pos.size : undefined;
        this.recordTrade(tokenId, outcome, 'SELL', currentPrice, pos.size, pnl, costCents);
      }
      this.positions.delete(tokenId);
      this.pendingSellOrders.delete(tokenId);
      return true;
    }

    if (!this.clobClient) {
      console.error('Trading client not initialized');
      return false;
    }

    try {
      // 跳過全局 cancelAll，避免取消下一輪掛單；直接使用當前餘額進行賣出

      // 1. 查詢可用餘額
      const balances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
      const rawAllowance = parseFloat(balances?.allowance || '0') / 1e6;
      const sellSize = parseFloat(rawAllowance.toFixed(1));

      if (sellSize <= 0) {
        console.log(`[強制清倉] 無可賣股份`);
        this.positions.delete(tokenId);
        this.pendingSellOrders.delete(tokenId);
        return true;
      }

      // 2. Market Sell（用較低價格確保成交）
      const marketPrice = Math.max((currentPrice - 10) / 100, 0.01); // 當前價 -10¢
      console.log(`🚨 Market Sell: ${sellSize} 股 ${outcome} @ ${marketPrice.toFixed(2)}`);

      const response = await this.clobClient.createAndPostOrder({
        tokenID: tokenId,
        price: marketPrice,
        size: sellSize,
        side: Side.SELL,
      });

      console.log(`✅ 強制清倉完成: ${response.orderID}`);
      this.positions.delete(tokenId);
      this.pendingSellOrders.delete(tokenId);
      return true;
    } catch (error: any) {
      console.error('[強制清倉] 失敗:', error?.message || error);
      return false;
    }
  }

  /**
   * 賣出指定 outcome
   */
  async sell(
    tokenId: string,
    outcome: 'Up' | 'Down',
    price: number,
    size: number,
    reason: string = 'signal'
  ): Promise<boolean> {
    const priceDecimal = price / 100;
    const position = this.positions.get(tokenId);

    if (config.PAPER_TRADING) {
      const pnl = position ? (price - position.avgBuyPrice) * size : 0;
      console.log(`📝 [PAPER] SELL ${size} ${outcome} @ ${priceDecimal.toFixed(2)} | PnL: ${pnl.toFixed(2)}¢`);
      this.updatePosition(tokenId, outcome, -size, price);
      const costCents = position ? position.avgBuyPrice * size : undefined;
      this.recordTrade(tokenId, outcome, 'SELL', price, size, pnl, costCents, tokenId);
      return true;
    }

    if (!this.clobClient) {
      console.error('Trading client not initialized');
      return false;
    }

    try {
      const avgBuy = position?.avgBuyPrice ?? price;
      let plannedSize = size;
      const isStopLoss = reason.toLowerCase().includes('stop') || reason.includes('止損');
      const meetsTarget = position ? ((price - position.avgBuyPrice) / position.avgBuyPrice) >= config.PROFIT_TARGET_PCT : true;
      if (!isStopLoss && !meetsTarget) {
        console.log(`[SELL] Skip due to no edge: price=${price} avg=${position?.avgBuyPrice} targetPct=${(config.PROFIT_TARGET_PCT * 100).toFixed(2)}% reason=${reason}`);
        return false;
      }

      // Reconcile on-chain allowance/balance to avoid over-sized orders
      try {
        const balances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
        const rawBalance = parseFloat(balances?.balance || '0') / 1e6;
        let rawAllowance = parseFloat(balances?.allowance || '0') / 1e6;
        if (rawAllowance < 0.01 && rawBalance > 0.01) rawAllowance = rawBalance;
        const maxSellable = Math.max(0, Math.min(rawBalance, rawAllowance, position?.size ?? size));
        plannedSize = Math.min(plannedSize, maxSellable);
        if (plannedSize <= 0) {
          console.warn(`[SELL] No allowance/balance to sell token=${tokenId} balance=${rawBalance.toFixed(3)} allowance=${rawAllowance.toFixed(3)}`);
          return false;
        }
        if (plannedSize < 5) {
          console.warn(`[SELL] Size ${plannedSize.toFixed(2)} < exchange min, using marketSellRemainder`);
          const cleaned = await this.marketSellRemainder(tokenId, outcome, price, 'sell-under-min');
          if (!cleaned) console.warn('[SELL] marketSellRemainder failed');
          return cleaned;
        }
      } catch (e: any) {
        console.log(`[SELL] balance/allowance check failed, proceed with planned size ${plannedSize}: ${e?.message}`);
      }

      const response = await this.clobClient.createAndPostOrder({
        tokenID: tokenId,
        price: priceDecimal,
        size: plannedSize,
        side: Side.SELL,
      });
      let executedPriceCents = price;
      let executedSize = plannedSize;
      try {
        for (let i = 0; i < 5; i++) {
          await this.sleep(400);
          const orderInfo: any = await this.clobClient.getOrder(response.orderID);
          const avg = orderInfo?.averagePrice ?? orderInfo?.average_price;
          const filled = orderInfo?.sizeFilled ?? orderInfo?.size_filled ?? orderInfo?.filled ?? orderInfo?.filledSize ?? orderInfo?.totalFilled ?? orderInfo?.size_filled_total;
          if (avg) executedPriceCents = Math.round(parseFloat(avg) * 100);
          if (filled) executedSize = parseFloat(filled);
          if (avg || filled) break;
        }
      } catch (e: any) {
        console.log(`[SELL] 讀取成交價失敗，使用提交價: ${e?.message}`);
      }

      // Clamp executed size to available position to avoid over-deducting
      const sizeToClose = position ? Math.min(executedSize, position.size) : executedSize;
      const pnl = position ? (executedPriceCents - avgBuy) * sizeToClose : 0;
      const costCents = position ? avgBuy * sizeToClose : undefined;

      console.log(`✅ SELL order placed: ${response.orderID} | filled ${sizeToClose.toFixed(2)} @ ${(executedPriceCents / 100).toFixed(2)} | PnL: ${pnl.toFixed(2)}¢ | reason=${reason}`);
      this.updatePosition(tokenId, outcome, -sizeToClose, executedPriceCents);
      this.recordTrade(tokenId, outcome, 'SELL', executedPriceCents, sizeToClose, pnl, costCents, tokenId);
      return true;
    } catch (error) {
      console.error('Sell order failed:', error);
      return false;
    }
  }

  /**
   * 取消所有未成交訂單
   */
  async cancelAllOrders(): Promise<void> {
    if (config.PAPER_TRADING || !this.clobClient) return;

    try {
      await this.clobClient.cancelAll();
      console.log('🗑️ All orders cancelled');
    } catch (error) {
      console.error('Failed to cancel orders:', error);
    }
  }

  /**
   * 清倉 - 賣出所有持倉
   */
  async liquidateAll(currentPrices: Map<string, number>): Promise<void> {
    for (const [tokenId, position] of this.positions) {
      if (position.size > 0) {
        const currentPrice = currentPrices.get(tokenId) || position.currentPrice;
        await this.sell(tokenId, position.outcome, currentPrice, position.size);
      }
    }
  }

  /**
   * 更新持倉記錄
   */
  private updatePosition(
    tokenId: string,
    outcome: 'Up' | 'Down',
    sizeDelta: number,
    price: number
  ): void {
    const existing = this.positions.get(tokenId) || {
      tokenId,
      outcome,
      size: 0,
      avgBuyPrice: 0,
      currentPrice: 0,
    };

    if (sizeDelta > 0) {
      // 買入 - 計算新的平均成本
      existing.avgBuyPrice =
        (existing.avgBuyPrice * existing.size + price * sizeDelta) / (existing.size + sizeDelta);
      this.cachedAvgPrices.set(tokenId, existing.avgBuyPrice);
      void this.savePriceCache();
    }
    const newSize = existing.size + sizeDelta;

    if (newSize <= 0) {
      this.positions.delete(tokenId);
      this.bracketOrdersPlaced.delete(tokenId);
      this.stopLossWatch.delete(tokenId);
      this.cachedAvgPrices.delete(tokenId);
      void this.savePriceCache();
    } else {
      existing.size = newSize;
      // Do NOT overwrite avgBuyPrice on sells; only update currentPrice snapshot
      existing.currentPrice = price;
      this.positions.set(tokenId, existing);
    }
  }

  /**
   * 在開盤前 10 秒掛出止盈/止損兩張賣單（精確出口）
   */
  async placeBracketOrders(
    tokenId: string,
    outcome: 'Up' | 'Down',
    avgBuyPrice: number,
    currentPrice: number,
    timeToStartMs: number
  ): Promise<boolean> {
    if (config.PAPER_TRADING || !this.clobClient) return false;

    // 僅在開盤前小窗執行一次（允許 -2s ~ 12s 容錯）
    if (timeToStartMs > 12_000 || timeToStartMs < -2_000) return false;
    if (this.bracketOrdersPlaced.has(tokenId)) return true;

    try {
      const balances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
      if (!balances) return false;

      const rawBalance = parseFloat(balances.balance || '0') / 1e6;
      let rawAllowance = parseFloat(balances.allowance || '0') / 1e6;
      if (rawAllowance < rawBalance) {
        try {
          await this.clobClient.updateBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
          await this.sleep(400);
          const newBalances = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL' as any, token_id: tokenId });
          rawAllowance = parseFloat(newBalances?.allowance || '0') / 1e6;
        } catch (e: any) {
          console.warn('[Bracket] approve failed:', e?.message || e);
        }
      }

      const size = rawAllowance > 0.05 ? Math.floor(rawAllowance * 10) / 10 : 0;
      if (size <= 0 || size < 5) {
        console.warn(`[Bracket] 可賣數量 ${size.toFixed(1)} 太小，跳過`);
        return false;
      }

      const tpPrice = Math.min(Math.max((avgBuyPrice + config.PROFIT_TARGET) / 100, 0.01), 0.99);
      const slPrice = Math.max((avgBuyPrice - config.STOP_LOSS) / 100, 0.01);

      console.log(`[Bracket] 下單 TP=${tpPrice.toFixed(2)} (watch SL=${slPrice.toFixed(2)}) size=${size} (avg=${(avgBuyPrice / 100).toFixed(2)} cur=${(currentPrice / 100).toFixed(2)})`);

      // 只掛止盈單，止損用監視觸發市價/市價限價
      try {
        const tp = await this.clobClient.createAndPostOrder({ tokenID: tokenId, price: tpPrice, size, side: Side.SELL });
        const tpId = tp.orderID || 'tp';
        this.pendingSellOrders.set(tokenId, tpId);
      } catch (e: any) {
        console.error('[Bracket] 止盈掛單失敗:', e?.message || e);
        this.pendingSellOrders.delete(tokenId);
      }

      // 設定止損監視
      this.stopLossWatch.set(tokenId, { outcome, price: slPrice * 100 }); // store cents for compare

      // 如果 TP 也沒掛上，仍然兜底市價清倉
      if (!this.pendingSellOrders.get(tokenId)) {
        console.warn('[Bracket] TP 掛單失敗，觸發市價兜底');
        await this.forceLiquidate(tokenId, outcome, currentPrice);
        this.stopLossWatch.delete(tokenId);
      }

      this.bracketOrdersPlaced.add(tokenId);
      return true;
    } catch (error: any) {
      console.error('[Bracket] 下單失敗:', error?.message || error);
      return false;
    }
  }

  private recordTrade(
    market: string,
    outcome: 'Up' | 'Down',
    side: 'BUY' | 'SELL',
    price: number,
    size: number,
    pnl?: number,
    costCents?: number,
    tokenId?: string,
  ): void {
    this.tradeHistory.push({
      timestamp: new Date(),
      tokenId: tokenId || market,
      market,
      outcome,
      side,
      price,
      size,
      pnl,
      costCents,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getWalletBalance(): Promise<number> {
    if (config.PAPER_TRADING || !this.clobClient) return 0;
    try {
      const resp: any = await this.clobClient.getBalanceAllowance({ asset_type: 'COLLATERAL' as any });
      const balance = parseFloat(resp?.balance || '0') / 1e6;
      return balance;
    } catch (e: any) {
      console.warn('[Wallet] 查詢 USDC 餘額失敗:', e?.message || e);
      return 0;
    }
  }

  getPositions(): Map<string, Position> {
    return this.positions;
  }

  getTradeHistory(): TradeRecord[] {
    return this.tradeHistory;
  }

  getTotalPnL(): number {
    return this.tradeHistory
      .filter((t) => t.pnl !== undefined)
      .reduce((sum, t) => sum + (t.pnl || 0), 0);
  }

  private async loadPriceCache(): Promise<void> {
    try {
      const data = await fs.readFile(POS_CACHE_PATH, 'utf-8');
      const json = JSON.parse(data || '{}');
      for (const [tokenId, avg] of Object.entries(json)) {
        if (typeof avg === 'number' && Number.isFinite(avg)) {
          this.cachedAvgPrices.set(tokenId, avg);
        }
      }
    } catch {
      // ignore missing/invalid cache
    }
  }

  private async savePriceCache(): Promise<void> {
    try {
      const obj: Record<string, number> = {};
      for (const [k, v] of this.cachedAvgPrices.entries()) {
        obj[k] = v;
      }
      await fs.writeFile(POS_CACHE_PATH, JSON.stringify(obj), 'utf-8');
    } catch (err) {
      console.warn('[Cache] Failed to save positions cache:', (err as Error)?.message || err);
    }
  }

  reset(): void {
    this.positions.clear();
    this.pendingSellOrders.clear();
    this.tradeHistory = [];
  }
}
