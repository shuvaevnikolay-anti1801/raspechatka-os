import type { DeviceHealth } from './contracts';
import type { AtolDriverBridge, AtolDriverDevice } from './atol-driver';

/**
 * Native bridge boundary for ATOL Driver 10.
 *
 * This class is intentionally isolated from Electron UI and fiscal logic.
 * The next implementation step is binding this layer to the installed
 * ATOL Driver SDK (COM/OLE or native DLL bridge).
 */
export class NativeAtolDriverBridge implements AtolDriverBridge {
  async findDevices(): Promise<AtolDriverDevice[]> {
    throw new Error(
      'ATOL Driver bridge is not installed. Configure native SDK binding first.'
    );
  }

  async connect(_device: AtolDriverDevice): Promise<void> {
    throw new Error('ATOL Driver connection is not implemented yet');
  }

  async disconnect(): Promise<void> {
    return;
  }

  async health(): Promise<DeviceHealth> {
    return {
      ready: false,
      status: 'not_configured',
      message:
        'Прямое подключение АТОЛ через драйвер подготовлено, но native bridge ещё не подключён',
    };
  }
}
