'use strict';

/**
 * Classic round robin: cycles through healthy backends in order.
 */
class RoundRobinStrategy {
  constructor() {
    this._index = 0;
  }

  pick(backends) {
    const healthy = backends.filter(b => b.healthy);
    if (healthy.length === 0) return null;
    const backend = healthy[this._index % healthy.length];
    this._index = (this._index + 1) % healthy.length;
    return backend;
  }
}

/**
 * Sends each request to whichever healthy backend currently has the
 * fewest in-flight requests. Better than round robin when requests have
 * uneven cost, since a slow backend naturally receives less new traffic.
 */
class LeastConnectionsStrategy {
  pick(backends) {
    const healthy = backends.filter(b => b.healthy);
    if (healthy.length === 0) return null;
    return healthy.reduce((best, b) => (b.activeConnections < best.activeConnections ? b : best));
  }
}

/**
 * Smooth weighted round robin, the same algorithm nginx uses: each pick
 * increases every backend's running total by its weight, then selects
 * (and discounts) the backend with the highest running total. This
 * spreads out bursts instead of clustering all of one backend's requests
 * together the way naive weighted round robin does.
 */
class WeightedRoundRobinStrategy {
  constructor() {
    this._current = new Map();
  }

  pick(backends) {
    const healthy = backends.filter(b => b.healthy);
    if (healthy.length === 0) return null;

    let total = 0;
    let selected = null;
    for (const b of healthy) {
      const weight = b.weight || 1;
      total += weight;
      const running = (this._current.get(b.id) || 0) + weight;
      this._current.set(b.id, running);
      if (selected === null || running > this._current.get(selected.id)) {
        selected = b;
      }
    }
    this._current.set(selected.id, this._current.get(selected.id) - total);
    return selected;
  }
}

module.exports = { RoundRobinStrategy, LeastConnectionsStrategy, WeightedRoundRobinStrategy };
