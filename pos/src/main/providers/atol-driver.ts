import type {
  DeviceHealth,
  FiscalOperationStatus,
  FiscalProvider,
  FiscalRequest,
  FiscalResult,
  FiscalReturnRequest,
  FiscalShiftStatus,
} from './contracts';
import type { PrintResult } from '../../shared/contracts';

/**
 * Direct ATOL Driver 10 integration.
 * Hardware access is isolated behind the COM bridge.
 */
export type AtolDriverDevice = {
  id: string;
  model: string;
  serialNumber?: string;
  connection: 'usb' | 'com' | 'unknown';
};

export interface AtolDriverBridge {
  findDevices(): Promise<AtolDriverDevice[]>;
  connect(device: AtolDriverDevice): Promise<void>;
  disconnect(): Promise<void>;
  health(): Promise<DeviceHealth>;
}

export class AtolDriverFiscalProvider implements FiscalProvider {
  constructor(private readonly bridge: AtolDriverBridge) {}

  async listDevices(): Promise<AtolDriverDevice[]> {
    return this.bridge.findDevices();
  }

  async connectDevice(device: AtolDriverDevice): Promise<void> {
    await this.bridge.connect(device);
  }

  async healthCheck(): Promise<DeviceHealth> {
    return this.bridge.health();
  }

  async getShiftStatus(): Promise<FiscalShiftStatus> {
    throw new Error('ATOL Driver shift status is not implemented yet');
  }

  async openShift(): Promise<void> {
    throw new Error('ATOL Driver open shift is not implemented yet');
  }

  async closeShift(): Promise<{ message: string; reportNumber?: string }> {
    throw new Error('ATOL Driver close shift is not implemented yet');
  }

  async fiscalizeSale(_request: FiscalRequest): Promise<FiscalResult> {
    throw new Error('ATOL Driver sale is not implemented yet');
  }

  async fiscalizeReturn(_request: FiscalReturnRequest): Promise<FiscalResult> {
    throw new Error('ATOL Driver return is not implemented yet');
  }

  async getOperationStatus(): Promise<FiscalOperationStatus> {
    return {
      status: 'unknown',
      message: 'ATOL Driver operation status is not implemented yet',
    };
  }

  async reprintReceipt(): Promise<PrintResult> {
    throw new Error('ATOL Driver reprint is not implemented yet');
  }
}
