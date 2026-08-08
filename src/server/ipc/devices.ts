import { registerServer } from './guard';
import { readDevices, revokeDevice } from '../transport/auth';
import { createPairingCode, pendingPairings } from '../transport/pairing';
import { dropDeviceStreams } from '../startup/transport';
import { log } from '../log';
import type { DeviceInfo, DevicesSnapshot, PairingCodeInfo } from '../../shared/types';

/**
 * The device registry, as Settings → Server → Devices sees it: which clients can reach
 * this server, which pairings are still outstanding, and how to end either.
 *
 * Note what is NOT here: nothing returns a token. The registry holds hashes, so
 * there is no "show me this device's credential" to expose even by accident; the
 * only value that ever leaves is a fresh pairing code, and that one is minted
 * expressly to be read out loud.
 *
 * Nor is there any notion of "the device asking". dispatchLocal has no caller
 * identity by design — every call arrives having already proved itself at the
 * transport, and nothing downstream re-derives who it was. A client that wants
 * to point at its own row in the list knows its own id (client.json) and says so
 * locally; see `client:info` in src/desktop/local.
 */
export function registerDevicesIpc(): void {
  registerServer('devices:list', () => snapshot());
  registerServer('devices:revoke', async (_e, id: string): Promise<DevicesSnapshot> => {
    const removed = await revokeDevice(id);
    // The credential is gone, which decides the device's NEXT request. Its event
    // stream is a socket that is already open, and would otherwise keep
    // delivering every push for as long as it stayed up.
    const dropped = removed ? dropDeviceStreams(id) : 0;
    if (removed) log('devices', 'revoked a device', { id, streamsDropped: dropped });
    return snapshot();
  });
  registerServer(
    'devices:createPairingCode',
    (_e, label: string): Promise<PairingCodeInfo> => createPairingCode(label)
  );
}

async function snapshot(): Promise<DevicesSnapshot> {
  const [devices, pending] = await Promise.all([readDevices(), pendingPairings()]);
  return {
    devices: devices.map(
      (d): DeviceInfo => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt
      })
    ),
    pending: pending.map((p) => ({ label: p.label, expiresAt: p.expiresAt }))
  };
}
