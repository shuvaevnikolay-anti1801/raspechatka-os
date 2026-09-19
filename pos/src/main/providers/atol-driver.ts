import type { PrintResult } from "../../shared/contracts";
import type { DeviceHealth, FiscalOperationStatus, FiscalProvider, FiscalRequest, FiscalResult, FiscalReturnRequest, FiscalShiftStatus } from "./contracts";
import { buildAtolReceiptJson, buildAtolShiftJson, pickAtolString } from "./atol-json";
import type { AtolSettingsStore } from "./atol-settings";

export type AtolDriverInfo = { installed:boolean; version?:string; architecture?:"x64"|"x86"; error?:string; code?:string };
export type AtolDriverDevice = { id:string; modelName:string; serialNumber:string; firmwareVersion?:string; connection:"usb"|"com"|"tcp"|"unknown"; settingsJson:string };
export type AtolDriverStatus = { connected:boolean; driverVersion?:string; serialNumber?:string; modelName?:string; firmwareVersion?:string; shiftState?:string|number; paperPresent?:boolean; coverOpened?:boolean; printerConnectionLost?:boolean; printerError?:boolean; fnPresent?:boolean; invalidFn?:boolean; deviceBlocked?:boolean; errorCode?:number; errorDescription?:string };
export interface AtolDriverBridge {
  getDriverInfo():Promise<AtolDriverInfo>;
  findDevices():Promise<AtolDriverDevice[]>;
  connect(device:AtolDriverDevice):Promise<void>;
  disconnect():Promise<void>;
  getStatus():Promise<AtolDriverStatus>;
  executeJson(request:Record<string,unknown>):Promise<Record<string,unknown>>;
  health():Promise<DeviceHealth>;
}

export class AtolDriverFiscalProvider implements FiscalProvider {
  private connectedSerial?:string;
  constructor(
    private readonly bridge:AtolDriverBridge,
    private readonly settingsStore:AtolSettingsStore,
    private readonly currentOperator:()=>string|undefined=()=>undefined
  ) {}

  async healthCheck():Promise<DeviceHealth> {
    const settings=this.settingsStore.load();
    if(!settings.enabled||settings.adapter!=="driver") return {ready:false,status:"not_configured",message:"Прямое подключение АТОЛ не настроено"};
    try { await this.ensureConnected(); return await this.bridge.health(); }
    catch(error) { return {ready:false,status:"offline",message:error instanceof Error?error.message:String(error)}; }
  }

  async getShiftStatus():Promise<FiscalShiftStatus> {
    await this.ensureConnected();
    const status=await this.bridge.getStatus();
    const state=String(status.shiftState??"unknown");
    if(state==="opened") return {open:true,state:"opened",message:"АТОЛ готов · смена открыта"};
    if(state==="closed") return {open:false,state:"closed",message:"АТОЛ готов · смена закрыта"};
    if(state==="expired") return {open:true,state:"expired",message:"Фискальная смена истекла и требует закрытия"};
    throw new Error("АТОЛ вернул неизвестное состояние смены: "+state);
  }

  async openShift(operatorName?:string):Promise<void> {
    await this.execute(buildAtolShiftJson("openShift",operatorName??this.currentOperator()));
  }

  async closeShift(operatorName?:string):Promise<{message:string;reportNumber?:string}> {
    const result=this.resultObject(await this.execute(buildAtolShiftJson("closeShift",operatorName??this.currentOperator())));
    return {message:"Фискальная смена закрыта",reportNumber:this.pick(result,["fiscalDocumentNumber","shiftNumber"])};
  }

  async fiscalizeSale(request:FiscalRequest):Promise<FiscalResult> { return this.fiscalize("sell",request); }
  async fiscalizeReturn(request:FiscalReturnRequest):Promise<FiscalResult> { return this.fiscalize("sellReturn",request); }

  async getOperationStatus():Promise<FiscalOperationStatus> {
    return {status:"unknown",message:"Прямой Драйвер ККТ не подтверждает исход прошлой операции без recovery-проверки."};
  }

  async reprintReceipt(request:{saleId:string;receiptNumber:string}):Promise<PrintResult> {
    await this.execute({type:"printLastReceiptCopy"});
    return {kind:"fiscal-copy",status:"printed",message:"Копия последнего фискального чека отправлена на АТОЛ ("+request.receiptNumber+")"};
  }

  private async fiscalize(type:"sell"|"sellReturn",request:FiscalRequest|FiscalReturnRequest):Promise<FiscalResult> {
    const settings=this.settingsStore.load();
    const result=await this.execute(buildAtolReceiptJson({
      type,amountMinor:request.amountMinor,payments:request.payments,lines:request.lines,
      taxationType:settings.taxationType,taxType:settings.taxType,operatorName:this.currentOperator()
    }));
    return this.parseFiscalResult(this.resultObject(result));
  }

  private async execute(request:Record<string,unknown>):Promise<Record<string,unknown>> {
    await this.ensureConnected();
    return this.bridge.executeJson(request);
  }

  private async ensureConnected():Promise<void> {
    const settings=this.settingsStore.load();
    const selected=settings.direct?.selectedDevice;
    if(!settings.enabled||settings.adapter!=="driver"||!selected) throw new Error("Выберите и сохраните ККТ АТОЛ для прямого подключения");
    if(this.connectedSerial===selected.serialNumber){
      try {
        const status=await this.bridge.getStatus();
        if(status.connected&&status.serialNumber===selected.serialNumber)return;
      } catch {}
      await this.bridge.disconnect().catch(()=>undefined);
      this.connectedSerial=undefined;
    } else if(this.connectedSerial) {
      await this.bridge.disconnect().catch(()=>undefined);
      this.connectedSerial=undefined;
    }
    await this.bridge.connect({id:"atol:"+selected.serialNumber,modelName:selected.modelName,serialNumber:selected.serialNumber,connection:selected.connection,settingsJson:selected.settingsJson});
    const status=await this.bridge.getStatus();
    if(!status.connected||status.serialNumber!==selected.serialNumber){
      await this.bridge.disconnect().catch(()=>undefined);
      throw new Error(`Подключена другая ККТ АТОЛ: ожидалась №${selected.serialNumber}, обнаружена №${status.serialNumber??"неизвестно"}`);
    }
    this.connectedSerial=selected.serialNumber;
  }

  private parseFiscalResult(result:Record<string,unknown>):FiscalResult {
    const fiscal=this.object(result.fiscalParams);
    const fiscalDocumentNumber=
      (fiscal?this.pick(fiscal,["fiscalDocumentNumber"]):undefined)??
      this.pick(result,["fiscalDocumentNumber"]);
    if(!fiscalDocumentNumber)
      throw new Error("АТОЛ завершил операцию, но не вернул номер фискального документа ФН");
    return {
      receiptNumber:fiscalDocumentNumber,
      documentNumber:this.pick(result,["documentNumber"]),
      fiscalDocumentNumber,
      fiscalSign:
        (fiscal?this.pick(fiscal,["fiscalSign","fiscalSignShort"]):undefined)??
        this.pick(result,["fiscalSign","fiscalSignShort"]),
      shiftNumber:
        (fiscal?this.pick(fiscal,["shiftNumber"]):undefined)??
        this.pick(result,["shiftNumber"]),
      raw:result
    };
  }

  private resultObject(value:Record<string,unknown>):Record<string,unknown>{ return this.object(value.result)??value; }
  private object(value:unknown):Record<string,unknown>|undefined { return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined; }
  private pick(source:Record<string,unknown>,keys:string[]):string|undefined { return pickAtolString(source,keys); }
}
