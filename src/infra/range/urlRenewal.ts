/**
 * Presigned-URL renewal shared by every source a viewer has open.
 *
 * A source that gets 401 / 403 (or starts a request within 60 s of `urlExpiresAt`) asks the
 * renewal for a fresh URL. The host's `refreshUrls` is called once per batch with the current
 * URL of every live source (they normally expire together); concurrent callers share the call.
 * If the renewed URL fails as well, the source reports its ordinary error and renewal backs off.
 */
export type RefreshUrls = (expired: string[]) => Promise<string[]>;

export interface RenewableUrl {
  getUrl(): string;
  setUrl(url: string): void;
}

const EXPIRY_MARGIN_MS = 60_000;
const BACKOFF_MS = 30_000;
const FRESH_URL_MS = 10_000;

export class UrlRenewal {
  #refresh?: RefreshUrls;
  #expiresAtMs?: number;
  #lastExpiresProp?: string;
  #sources = new Set<RenewableUrl>();
  #inflight?: Promise<void>;
  #backoffUntil = 0;
  /** When each URL was issued by a renewal; a 403 within seconds of that is a real failure, not expiry. */
  #renewedAt = new Map<string, number>();
  /** Number of `refreshUrls` calls so far (diagnostics and tests). */
  calls = 0;

  update(options: { refreshUrls?: RefreshUrls; urlExpiresAt?: string }): void {
    this.#refresh = options.refreshUrls;
    // A renewal consumes the declared expiry; only a *new* `urlExpiresAt` value re-arms it, so a
    // re-render with the old prop does not trigger another refresh.
    if (options.urlExpiresAt !== this.#lastExpiresProp) {
      this.#lastExpiresProp = options.urlExpiresAt;
      const ms = options.urlExpiresAt ? Date.parse(options.urlExpiresAt) : NaN;
      this.#expiresAtMs = Number.isFinite(ms) ? ms : undefined;
    }
  }

  get enabled(): boolean {
    return this.#refresh != undefined;
  }

  register(source: RenewableUrl): () => void {
    this.#sources.add(source);
    return () => this.#sources.delete(source);
  }

  /** True when the host declared an expiry and it is less than a minute away. */
  expiringSoon(): boolean {
    return this.#refresh != undefined && this.#expiresAtMs != undefined && Date.now() >= this.#expiresAtMs - EXPIRY_MARGIN_MS;
  }

  /**
   * Renews every live source's URL. Resolves true when `source` now has a URL different from
   * `failedUrl` and the request should be retried once.
   */
  async renew(source: RenewableUrl, failedUrl: string): Promise<boolean> {
    if (!this.#refresh) return false;
    if (source.getUrl() !== failedUrl) return true; // another request already renewed it
    const issuedAt = this.#renewedAt.get(failedUrl);
    if (issuedAt != undefined && Date.now() - issuedAt < FRESH_URL_MS && !this.#inflight) {
      // A URL we just obtained from the host failed too: stop asking.
      this.#backoffUntil = Date.now() + BACKOFF_MS;
      return false;
    }
    if (!this.#inflight && Date.now() < this.#backoffUntil) return false;
    this.#inflight ??= this.#run().finally(() => {
      this.#inflight = undefined;
    });
    try {
      await this.#inflight;
    } catch {
      return false;
    }
    return source.getUrl() !== failedUrl;
  }

  async #run(): Promise<void> {
    const refresh = this.#refresh;
    if (!refresh) return;
    const sources = [...this.#sources];
    const expired = sources.map((s) => s.getUrl());
    this.calls += 1;
    let fresh: string[];
    try {
      fresh = await refresh(expired);
    } catch (err) {
      this.#backoffUntil = Date.now() + BACKOFF_MS;
      throw err;
    }
    if (!Array.isArray(fresh) || fresh.length !== expired.length || fresh.some((u) => typeof u !== 'string' || !u)) {
      this.#backoffUntil = Date.now() + BACKOFF_MS;
      throw new Error('refreshUrls must resolve to one URL per expired URL, in order');
    }
    sources.forEach((s, i) => {
      if (fresh[i] !== expired[i]) {
        this.#renewedAt.set(fresh[i], Date.now());
        s.setUrl(fresh[i]);
      }
    });
    // The old expiry no longer applies; the host may pass a new `urlExpiresAt` prop.
    this.#expiresAtMs = undefined;
  }
}
