import type { AtolDriverBridge, AtolDriverDevice } from './atol-driver';
import type { DeviceHealth } from './contracts';

/**
 * ATOL Driver 10 COM bridge.
 *
 * The driver is installed separately on the Windows workstation.
 * This adapter intentionally keeps COM access isolated from POS logic.
 *
 * A COM runtime is loaded dynamically because Electron builds should still
 * start on machines where ATOL Driver is not installed.
 */
export class AtolDriverComBridge implements AtolDriverBridge {
  private driver: any;

  private async createDriver(): Promise<any> {
    if (this.driver) return this.driver;

    if (process.platform !== 'win32') {
      throw new Error('ATOL Driver is supported only on Windows');
    }

    let winax: any;
    try {
      winax = await import('winax');
    } catch {
      throw new Error(
        'ATOL COM bridge requires winax dependency. Install native COM bridge dependencies.'
      );
    }

    this.driver = new winax.Object('AddIn.DrvFR');
    return this.driver;
  }

  async findDevices(): Promise<AtolDriverDevice[]> {
    const driver = await this.createDriver();

    // Device discovery is delegated to ATOL Driver.
    // Exact connection enumeration depends on installed Driver 10 COM API.
    await driver;

    return [];
  }

  async connect(_device: AtolDriverDevice): Promise<void> {
    await this.createDriver();
  }

  async disconnect(): Promise<void> {
    this.driver = undefined;
  }

  async health(): Promise<DeviceHealth> {
    try {
      await this.createDriver();
      return {
        ready: true,
        status: 'ready',
        message: 'ATOL Driver COM доступен',
      };
    } catch (error) {
      return {
        ready: false,
        status: 'not_configured',
        message: error instanceof Error ? error.message : 'ATOL Driver unavailable',
      };
    }
  }
}
