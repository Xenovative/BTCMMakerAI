import WebSocket from 'ws';

/**
 * 簡易 Polymarket 價格 websocket 客戶端（最佳努力）
 * - 嘗試訂閱 ticker/update 以取得 bid/ask/mid
 * - 若連線/解析失敗，僅記錄 log，不阻斷主流程
 */
export class LivePriceFeed {
  private ws: WebSocket | null = null;
  private readonly url = 'wss://ws-subscriptions-clob.polymarket.com/ws/book';
  private connected = false;
  private pendingTokens: Set<string> = new Set();
  private prices: Record<string, number> = {}; // tokenId -> price in cents

  connect(): void {
    if (this.ws) return;

    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      console.log('[WS] Price feed connected');
      if (this.pendingTokens.size > 0) {
        this.subscribe(Array.from(this.pendingTokens));
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      console.log('[WS] Price feed disconnected, retry in 5s');
      setTimeout(() => this.connect(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Price feed error:', err);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('[WS][MSG]', JSON.stringify(msg).slice(0, 200));
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
    // Book channel messages: expect bids/asks, keyed by token/asset id
    const tokenId = msg?.product_id || msg?.token_id || msg?.tokenId || msg?.asset_id;
    if (!tokenId) return;

    // Book updates often include bids/asks arrays; compute mid
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
    this.prices[tokenId] = priceCents;
  }

  getPrices(): Record<string, number> {
    return { ...this.prices };
  }

  /**
   * Manually set price from order book mid (fallback when WS silent)
   */
  setPrice(tokenId: string, priceCents: number): void {
    this.prices[tokenId] = priceCents;
  }
}

export const livePriceFeed = new LivePriceFeed();
