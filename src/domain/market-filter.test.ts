import { describe, expect, it } from "vitest";
import { evaluateVolumeExit } from "./market-filter.js";

const lowVolume = new Map([["low", 9_999], ["boundary", 10_000], ["healthy", 25_000]]);

describe("24h volume exit filter", () => {
  it("removes only watching tokens below the configured threshold", () => {
    const result = evaluateVolumeExit([
      { id: "1", address: "low", status: "WATCHING", hasOpenPosition: false },
      { id: "2", address: "boundary", status: "WATCHING", hasOpenPosition: false },
      { id: "3", address: "healthy", status: "WATCHING", hasOpenPosition: false }
    ], lowVolume, 10_000);

    expect(result.remove.map((item) => item.address)).toEqual(["low"]);
  });

  it("defers low-volume tokens while an open position exists", () => {
    const result = evaluateVolumeExit([
      { id: "1", address: "low", status: "HOLDING", hasOpenPosition: true }
    ], lowVolume, 10_000);

    expect(result.remove).toEqual([]);
    expect(result.deferred.map((item) => item.address)).toEqual(["low"]);
  });

  it("allows cleanup of a stale holding status when no open position exists", () => {
    const result = evaluateVolumeExit([
      { id: "1", address: "low", status: "HOLDING", hasOpenPosition: false }
    ], lowVolume, 10_000);

    expect(result.remove.map((item) => item.address)).toEqual(["low"]);
    expect(result.deferred).toEqual([]);
  });

  it("does nothing when Birdeye omitted the volume value", () => {
    const result = evaluateVolumeExit([
      { id: "1", address: "missing", status: "WATCHING", hasOpenPosition: false }
    ], lowVolume, 10_000);

    expect(result).toEqual({ remove: [], deferred: [] });
  });
});
