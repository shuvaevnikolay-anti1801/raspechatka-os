import type { AtolDriverBridge, AtolDriverDevice } from './atol-driver';
import type { DeviceHealth } from './contracts';

/**
 * Native ATOL Driver 10 COM/OLE adapter.
 *
 * All ATOL specific calls stay isolated here. POS layer does not know about
 * COM objects or Driver 10 API details.
 */
export class AtolDriverComBridge implements AtolDriverBridge {
  private driver: any;
  private connectedDevice?: AtolDriverDevice;

  private async createDriver(): Promise<any> {
    if (this.driver) return this.driver;

    if (process.platform !== 'win32') {
      throw new Error('Драйвер АТОЛ доступен только в Windows');
    }

    let winax: any;
    try {
      winax = await import('winax');
    } catch {
      throw new Error('Драйвер АТОЛ не установлен. Установите Драйвер ККТ АТОЛ 10.');
    }

    try {
      this.driver = new winax.Object('AddIn.DrvFR');
    } catch {
      throw new Error('Не удалось подключиться к драйверу АТОЛ.');
    }

    return this.driver;
  }

  async findDevices(): Promise<AtolDriverDevice[]> {
    const driver = await this.createDriver();

    try {
      const devices: AtolDriverDevice[] = [];

      // Driver 10 COM API differs between versions. We intentionally query
      // only real driver data and never create virtual/test devices.
      if (typeof driver.FindDevices === 'function') {
        const result = await driver.FindDevices();

        for (const item of result ?? []) {
          devices.push({
            id: String(item.SerialNumber ?? item.Id ?? item.id),
            model: String(item.Model ?? item.Name ?? 'АТОЛ'),
            serialNumber: item.SerialNumber ? String(item.SerialNumber) : undefined,
            connection: 'usb',
          });
        }
      }

      return devices;
    } catch {
      return [];
    }
  }

  async connect(device: AtolDriverDevice): Promise<void> {
    const driver = await this.createDriver();

    try {
      if (typeof driver.SetSingleSetting === 'function') {
        driver.SetSingleSetting(1, device.id);
      }

      if (typeof driver.Connect === 'function') {
        const result = driver.Connect();
        if (result !== 0 && result !== undefined) {
          throw new Error(String(result));
        }
      }

      this.connectedDevice = device;
    } catch {
      throw new Error('ККТ не найдена. Проверьте USB подключение и питание кассы.');
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.driver?.Disconnect) {
        this.driver.Disconnect();
      }
    } finally {
      this.connectedDevice = undefined;
      this.driver = undefined;
    }
  }

  async health(): Promise<DeviceHealth> {
    try {
      await this.createDriver();

      if (!this.connectedDevice) {
        return {
          ready: false,
          status: 'not_configured',
          message: 'ККТ не подключена',
        };
      }

      return {
        ready: true,
        status: 'ready',
        message: `${this.connectedDevice.model} подключена`,
      };
    } catch (error) {
      return {
        ready: false,
        status: 'not_configured',
        message: error instanceof Error ? error.message : 'Ошибка драйвера АТОЛ',
      };
    }
  }
}
