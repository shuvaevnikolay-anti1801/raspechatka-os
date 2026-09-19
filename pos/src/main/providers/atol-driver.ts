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

export type AtolDriverDevice = {
  id: string;
  model: string;
  serialNumber?: string;
  firmwareVersion?: string;
  connection: 'usb' | 'com' | 'tcp' | 'unknown';
  settingsJson?: string;
};

export type AtolDriverStatus = {
  connected: boolean;
  serialNumber?: string;
  modelName?: string;
  firmwareVersion?: string;
  shiftState?: string | number;
  paperPresent?: boolean;
  coverOpened?: boolean;
  printerError?: boolean;
  fnPresent?: boolean;
  fnError?: boolean;
  fnBlocked?: boolean;
  errorCode?: number;
  errorDescription?: string;
};

export interface AtolDriverBridge {
  findDevices(): Promise<AtolDriverDevice[]>;
  connect(device: AtolDriverDevice): Promise<void>;
  disconnect(): Promise<void>;
  health(): Promise<DeviceHealth>;
}

/**
 * Direct ATOL Driver provider boundary. Fiscal operations intentionally remain
 * unavailable until their unknown-outcome/recovery contract is implemented.
 */
export class AtolDriverFiscalProvider implements FiscalProvider {
  constructor(private readonly bridge: AtolDriverBridge) {}

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
