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
  private priceTimestamps: Record<string, number> = {}; // tokenId -> ms
  private bestBids: Record<string, number> = {};
  private bestAsks: Record<string, number> = {};
  private fetcher = new MarketFetcher();
  private restInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  connect(): void {
    if (this.ws) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    console.log('[WS] Attempting to connect to:', this.url);
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log('[WS] Price feed connected successfully');
      if (this.pendingTokens.size > 0) {
        this.subscribe(Array.from(this.pendingTokens));
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      console.log('[WS] Price feed disconnected, scheduling reconnect');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.warn('[WS] Price feed error, scheduling reconnect:', err.message);
      this.connected = false;
      this.ws = null;
      this.scheduleReconnect();
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

  forceReconnect(): void {
    console.warn('[WS] Forcing reconnect');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.connect();
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

  prune(activeTokenIds: string[]): void {
    const keep = new Set(activeTokenIds);
    this.pendingTokens = new Set([...this.pendingTokens].filter((t) => keep.has(t)));
    this.subscribedTokens = new Set([...this.subscribedTokens].filter((t) => keep.has(t)));
    Object.keys(this.prices).forEach((k) => {
      if (!keep.has(k)) {
        delete this.prices[k];
        delete this.priceTimestamps[k];
        delete this.bestBids[k];
        delete this.bestAsks[k];
      }
    });
    // Re-subscribe to kept tokens to refresh book streams
    if (keep.size > 0) {
      this.subscribe(Array.from(keep));
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
    if (!isFinite(spreadCents) || spreadCents <= 0 || spreadCents > 50) return;

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

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.connected || this.ws) return;
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 6);
    const delayMs = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts - 1));
    console.log(`[WS] Reconnect attempt ${this.reconnectAttempts} in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
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

  getPricesFresh(maxAgeMs: number): Record<string, number> {
    const now = Date.now();
    const fresh: Record<string, number> = {};
    let staleCount = 0;
    let minAge = Number.POSITIVE_INFINITY;
    let maxAge = 0;
    const freshKeys: string[] = [];
    const staleDetails: string[] = [];
    for (const [tokenId, price] of Object.entries(this.prices)) {
      const ts = this.priceTimestamps[tokenId] || 0;
      const age = now - ts;
      minAge = Math.min(minAge, age);
      maxAge = Math.max(maxAge, age);
      if (age <= maxAgeMs) {
        fresh[tokenId] = price;
        freshKeys.push(tokenId);
      } else {
        staleCount += 1;
        staleDetails.push(`${tokenId.slice(0, 6)}… age=${age}ms price=${price.toFixed(2)}`);
      }
    }
    const total = Object.keys(this.prices).length;

    // Watchdog: if any price is very stale, force reconnect and resubscribe
    if (staleCount > 0 && maxAge > maxAgeMs * 2) {
      const tokens = Array.from(this.subscribedTokens);
      this.forceReconnect();
      if (tokens.length > 0) {
        this.subscribe(tokens);
      }
      // Kick a one-shot REST poll as fallback
      void this.pollOrderBooks();
    }
    return fresh;
  }

  setPrice(tokenId: string, priceCents: number, force = false): void {
    const clamped = this.clampPrice(priceCents);
    if (!force) {
      const current = this.prices[tokenId];
      // If unchanged within 0.01¢, keep existing
      if (current !== undefined && Math.abs(current - clamped) < 0.01) return;
    }
    const prev = this.prices[tokenId];
    this.prices[tokenId] = clamped;
    this.priceTimestamps[tokenId] = Date.now();
  }

  private clampPrice(priceCents: number): number {
    if (priceCents < 0.5) return 0.5;
    if (priceCents > 99.5) return 99.5;
    return priceCents;
  }

  getPriceAges(): Record<string, number> {
    const now = Date.now();
    const ages: Record<string, number> = {};
    for (const [tokenId, ts] of Object.entries(this.priceTimestamps)) {
      ages[tokenId] = now - ts;
    }
    return ages;
  }

  getPriceCount(): number {
    return Object.keys(this.prices).length;
  }
}

export const livePriceFeed = new LivePriceFeed();
