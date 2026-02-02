import WebSocket from 'ws';
import { MarketFetcher } from '../market-fetcher.js';

/**
 * Polymarket price feed with WS book + REST polling fallback.
 */
export class LivePriceFeed {
  private ws: WebSocket | null = null;
  private readonly url = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  private connected = false;
  private pendingTokens: Set<string> = new Set();
  private subscribedTokens: Set<string> = new Set();
  private prices: Record<string, number> = {}; // tokenId -> price in cents
  private bestBids: Record<string, number> = {};
  private bestAsks: Record<string, number> = {};
  private fetcher = new MarketFetcher();
  private restInterval: NodeJS.Timeout | null = null;

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
    tokenIds.forEach((t) => {
      this.pendingTokens.add(t);
      this.subscribedTokens.add(t);
    });
    this.startRestPolling();
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
    const tokenId = msg?.asset_id || msg?.product_id || msg?.token_id || msg?.tokenId;
    if (!tokenId) return;

    // Use last trade price as seed when present
    const priceVal = msg?.price ?? msg?.last_price ?? (Array.isArray(msg?.price_changes) ? msg.price_changes[0]?.price : null);
    if (priceVal != null) {
      const price = Number(priceVal);
      if (!Number.isNaN(price)) {
        const priceCents = price < 5 ? price * 100 : price;
        if (priceCents > 0.5 && priceCents < 99.5) {
          this.setPrice(tokenId, priceCents, true);
          return;
        }
      }
    }

    const bids = msg?.bids || msg?.b || [];
    const asks = msg?.asks || msg?.a || [];
    const bestBid = bids[0]?.price ?? bids[0]?.[0] ?? null;
    const bestAsk = asks[0]?.price ?? asks[0]?.[0] ?? null;

    if (bestBid != null && !Number.isNaN(Number(bestBid))) {
      this.bestBids[tokenId] = Number(bestBid);
    }
    if (bestAsk != null && !Number.isNaN(Number(bestAsk))) {
      this.bestAsks[tokenId] = Number(bestAsk);
    }

    const bidNum = this.bestBids[tokenId];
    const askNum = this.bestAsks[tokenId];
    if (bidNum == null || askNum == null) return;

    const spreadCents = (askNum - bidNum) * 100;
    if (!isFinite(spreadCents) || spreadCents <= 0 || spreadCents > 20) return;

    const mid = (bidNum + askNum) / 2;
    const priceCents = mid < 5 ? mid * 100 : mid;
    this.setPrice(tokenId, priceCents, true);
  }

  private startRestPolling(): void {
    // REST seeding disabled per request
    if (this.restInterval) {
      clearInterval(this.restInterval);
      this.restInterval = null;
    }
  }

  private async pollOrderBooks(): Promise<void> {
    if (this.subscribedTokens.size === 0) return;
    for (const tokenId of Array.from(this.subscribedTokens)) {
      try {
        const ob = await this.fetcher.getOrderBook(tokenId);
        const bid = ob?.bids?.[0]?.price;
        const ask = ob?.asks?.[0]?.price;
        if (bid == null || ask == null) continue;
        const bidNum = parseFloat(bid);
        const askNum = parseFloat(ask);
        const spreadCents = (askNum - bidNum) * 100;
        if (!isFinite(spreadCents) || spreadCents <= 0 || spreadCents > 20) continue;
        const midCents = ((bidNum + askNum) / 2) * 100;
        this.setPrice(tokenId, midCents, true);
      } catch (err) {
        // ignore poll errors
      }
      await new Promise(res => setTimeout(res, 150));
    }
  }

  getPrices(): Record<string, number> {
    return { ...this.prices };
  }

  setPrice(tokenId: string, priceCents: number, force = false): void {
    if (!force && this.prices[tokenId] !== undefined) return;
    this.prices[tokenId] = priceCents;
  }

  getPriceCount(): number {
    return Object.keys(this.prices).length;
  }
}

export const livePriceFeed = new LivePriceFeed();
