import { useEffect, useState } from 'react';
import {
  connectGameToHost,
  observeGameContentSize,
  type GuestBridgeConnection,
  type HostApiV1,
  type HostSnapshotV1,
} from '@chain/casino-sdk/guest';

type SnapshotListener = (snapshot: HostSnapshotV1 | null) => void;

type HostBridge = {
  connection: GuestBridgeConnection;
  listeners: Set<SnapshotListener>;
  latest: HostSnapshotV1 | null;
};

let bridge: HostBridge | undefined;

/**
 * One connection per page. The host binds its guest proxy to the first
 * handshake, so connecting again on a remount (StrictMode in dev) would leave
 * the host pushing into a destroyed connection.
 */
function hostBridge(): HostBridge {
  if (bridge) return bridge;
  const listeners = new Set<SnapshotListener>();
  const created: HostBridge = {
    listeners,
    latest: null,
    connection: connectGameToHost({
      async setState(snapshot) {
        created.latest = snapshot;
        listeners.forEach(listener => listener(snapshot));
      },
    }),
  };
  bridge = created;
  return created;
}

/**
 * Guest side of the casino bridge: exposes the host's signing API once the
 * handshake resolves, and mirrors every `setState` push into React state.
 * If no host ever answers (the page was opened directly, outside the
 * chain.wtf iframe), `hostApi`/`snapshot` simply stay null forever -- the
 * caller is expected to fall back to standalone demo mode, which the jam's
 * own eligibility gate requires ("runs standalone as a playable demo").
 */
export function useCasinoHost(): {
  hostApi: HostApiV1 | null;
  snapshot: HostSnapshotV1 | null;
} {
  const [hostApi, setHostApi] = useState<HostApiV1 | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshotV1 | null>(null);

  useEffect(() => {
    const { connection, listeners, latest } = hostBridge();
    let mounted = true;
    listeners.add(setSnapshot);
    setSnapshot(latest);

    void connection.promise
      .then(parent => {
        if (mounted) setHostApi(parent);
      })
      .catch(() => {
        // Handshake failed — standalone demo mode takes over (see App.tsx).
      });

    return () => {
      mounted = false;
      listeners.delete(setSnapshot);
    };
  }, []);

  useEffect(() => {
    if (!hostApi) return;
    const observer = observeGameContentSize(hostApi);
    return () => observer.disconnect();
  }, [hostApi]);

  return { hostApi, snapshot };
}
