import WebSocket from 'ws';

/**
 * 簡易 Polymarket 價格 websocket 客戶端（最佳努力）
 * - 嘗試訂閱 ticker/update 以取得 bid/ask/mid
 * - 若連線/解析失敗，僅記錄 log，不阻斷主流程
 */
export class LivePriceFeed {
  private ws: WebSocket | null = null;
  private readonly url = 'wss://clob.polymarket.com/stream';
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
      type: 'subscribe',
      channels: [
        {
          name: 'ticker',
          product_ids: tokenIds,
        },
      ],
    };

    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[WS] Failed to send subscribe', err);
    }
  }

  private handleMessage(msg: any): void {
    const tokenId = msg?.product_id || msg?.token_id || msg?.tokenId;
    if (!tokenId) return;

    let mid: number | null = null;
    if (typeof msg.mid_price === 'number') mid = msg.mid_price;
    const bestBid = typeof msg.best_bid === 'number' ? msg.best_bid : (typeof msg.bid === 'number' ? msg.bid : null);
    const bestAsk = typeof msg.best_ask === 'number' ? msg.best_ask : (typeof msg.ask === 'number' ? msg.ask : null);
    if (mid === null && bestBid !== null && bestAsk !== null) {
      mid = (bestBid + bestAsk) / 2;
    }
    if (mid === null) return;

    const priceCents = mid < 5 ? mid * 100 : mid;
    this.prices[tokenId] = priceCents;
  }

  getPrices(): Record<string, number> {
    return { ...this.prices };
  }
}

export const livePriceFeed = new LivePriceFeed();
