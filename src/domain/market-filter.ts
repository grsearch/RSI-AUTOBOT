export type VolumeFilterToken = {
  id: string;
  address: string;
  status: string;
  hasOpenPosition: boolean;
};

export type VolumeExitCandidate = {
  id: string;
  address: string;
  volume24hUsd: number;
};

export function evaluateVolumeExit(
  tokens: VolumeFilterToken[],
  volumes: ReadonlyMap<string, number>,
  minimumVolume24hUsd: number
): { remove: VolumeExitCandidate[]; deferred: VolumeExitCandidate[] } {
  const remove: VolumeExitCandidate[] = [];
  const deferred: VolumeExitCandidate[] = [];

  for (const token of tokens) {
    const volume24hUsd = volumes.get(token.address);
    if (volume24hUsd == null || !Number.isFinite(volume24hUsd) || volume24hUsd < 0 || volume24hUsd >= minimumVolume24hUsd) continue;
    const candidate = { id: token.id, address: token.address, volume24hUsd };
    if (token.hasOpenPosition) deferred.push(candidate);
    else if (token.status === "WATCHING" || token.status === "HOLDING") remove.push(candidate);
  }

  return { remove, deferred };
}
