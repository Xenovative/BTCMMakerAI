import WebSocket from 'ws';

/**
 * 簡易 Polymarket 價格 websocket 客戶端（最佳努力）
 * - 嘗試訂閱 ticker/update 以取得 bid/ask/mid
 * - 若連線/解析失敗，僅記錄 log，不阻斷主流程
 */
export class LivePriceFeed {
  private ws: WebSocket | null = null;
  // Use /ws/market endpoint; channel determined by payload type
  private readonly url = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  private connected = false;
  private pendingTokens: Set<string> = new Set();
  private prices: Record<string, number> = {}; // tokenId -> price in cents

  connect(): void {
    if (this.ws) return;

    console.log('[WS] Attempting to connect to:', this.url);
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      console.log('[WS] Price feed connected successfully');
      if (this.pendingTokens.size > 0) {
        this.subscribe(Array.from(this.pendingTokens));
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      console.log('[WS] Price feed disconnected, will NOT retry (using order book mids instead)');
      // Don't retry - we have order book fallback
    });

    this.ws.on('error', (err) => {
      console.warn('[WS] Price feed error (falling back to order book mids):', err.message);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        // ignore malformed
      }
    });
  }

  subscribe(tokenIds: string[]): void {
    tokenIds.forEach((t) => this.pendingTokens.add(t));
    if (!this.connected || !this.ws) return;

    const payload: any = {
      type: 'book',
      assets_ids: tokenIds,
    };

    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[WS] Failed to send subscribe', err);
    }
  }

  private handleMessage(msg: any): void {
    // Handle price_changes array format
    if (msg.price_changes && Array.isArray(msg.price_changes)) {
      for (const change of msg.price_changes) {
        const tokenId = change.asset_id;
        const price = parseFloat(change.price);
        if (tokenId && !isNaN(price)) {
          const priceCents = price < 5 ? price * 100 : price;
          console.log('[WS][price_change] token=%s price=%s -> %d¢', tokenId, change.price, priceCents);
          this.setPrice(tokenId, priceCents, true); // force from WS
        }
      }
      return;
    }

    // Handle direct price update
    const tokenId = msg?.asset_id || msg?.product_id || msg?.token_id || msg?.tokenId;
    if (tokenId && msg.price != null) {
      const price = parseFloat(msg.price);
      if (!isNaN(price)) {
        const priceCents = price < 5 ? price * 100 : price;
        console.log('[WS][price] token=%s price=%s -> %d¢', tokenId, msg.price, priceCents);
        this.setPrice(tokenId, priceCents, true);
        return;
      }
    }

    // Handle bids/asks format
    if (tokenId) {
      const bids = msg?.bids || msg?.b || [];
      const asks = msg?.asks || msg?.a || [];
      const bestBid = bids[0]?.price ?? bids[0]?.[0] ?? null;
      const bestAsk = asks[0]?.price ?? asks[0]?.[0] ?? null;
      if (bestBid == null && bestAsk == null) return;
      const bidNum = bestBid != null ? Number(bestBid) : null;
      const askNum = bestAsk != null ? Number(bestAsk) : null;
      let mid: number | null = null;
      if (bidNum != null && askNum != null) mid = (bidNum + askNum) / 2;
      else if (bidNum != null) mid = bidNum;
      else if (askNum != null) mid = askNum;
      if (mid === null) return;

      const priceCents = mid < 5 ? mid * 100 : mid;
      console.log('[WS][book mid] token=%s mid=%s -> %d¢', tokenId, mid, priceCents);
      this.setPrice(tokenId, priceCents, true);
    }
  }

  getPrices(): Record<string, number> {
    return { ...this.prices };
  }

  /**
   * Manually set price from order book mid (fallback when WS silent)
   */
  setPrice(tokenId: string, priceCents: number, force = false): void {
    if (!force && this.prices[tokenId] !== undefined) return;
    this.prices[tokenId] = priceCents;
  }

  /**
   * Debug: get current price count
   */
  getPriceCount(): number {
    return Object.keys(this.prices).length;
  }
}

export const livePriceFeed = new LivePriceFeed();
