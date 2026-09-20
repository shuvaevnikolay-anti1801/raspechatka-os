import type { PrintResult } from "../../shared/contracts";
import type { DeviceHealth, FiscalOperationStatus, FiscalProvider, FiscalRecoveryEvidence, FiscalRecoverySnapshot, FiscalRequest, FiscalResult, FiscalReturnRequest, FiscalShiftStatus } from "./contracts";
import { buildAtolReceiptJson, buildAtolShiftJson, pickAtolString } from "./atol-json";
import type { AtolSettingsStore } from "./atol-settings";
import type { PosDiagnostics } from "../diagnostics";

export type AtolDriverInfo = { installed:boolean; version?:string; architecture?:"x64"|"x86"; error?:string; code?:string };
export type AtolDriverDevice = { id:string; modelName:string; serialNumber:string; firmwareVersion?:string; connection:"usb"|"com"|"tcp"|"unknown"; settingsJson:string };
export type AtolRecoveryProbe = FiscalRecoverySnapshot & { amount?:number };
export type AtolDriverStatus = { connected:boolean; driverVersion?:string; serialNumber?:string; modelName?:string; firmwareVersion?:string; shiftState?:string|number; paperPresent?:boolean; coverOpened?:boolean; printerConnectionLost?:boolean; printerError?:boolean; fnPresent?:boolean; invalidFn?:boolean; deviceBlocked?:boolean; errorCode?:number; errorDescription?:string };
export interface AtolDriverBridge {
  getDriverInfo():Promise<AtolDriverInfo>;
  findDevices():Promise<AtolDriverDevice[]>;
  connect(device:AtolDriverDevice):Promise<void>;
  disconnect():Promise<void>;
  getStatus():Promise<AtolDriverStatus>;
  recoveryProbe():Promise<AtolRecoveryProbe>;
  executeJson(request:Record<string,unknown>):Promise<Record<string,unknown>>;
  reprintDocument(documentNumber:string):Promise<Record<string,unknown>>;
  health():Promise<DeviceHealth>;
}

export class AtolDriverFiscalProvider implements FiscalProvider {
  private connectedSerial?:string;
  constructor(
    private readonly bridge:AtolDriverBridge,
    private readonly settingsStore:AtolSettingsStore,
    private readonly currentOperator:()=>string|undefined=()=>undefined,
    private readonly diagnostics?:PosDiagnostics
  ) {}

  async healthCheck():Promise<DeviceHealth> {
    const settings=this.settingsStore.load();
    if(!settings.enabled||settings.adapter!=="driver") return {ready:false,status:"not_configured",message:"Прямое подключение АТОЛ не настроено"};
    try { await this.ensureConnected(); return await this.bridge.health(); }
    catch(error) {
      const details=this.errorDetails(error);
      const notConfigured=details.errorCode==="not_configured";
      this.report(notConfigured?"atol.driver.missing":"atol.device.connection_lost",
        notConfigured?"ATOL bridge helper не найден":"Связь с ККТ АТОЛ потеряна",
        details,notConfigured?"warning":"warning");
      return {ready:false,status:notConfigured?"not_configured":"offline",message:error instanceof Error?error.message:String(error)};
    }
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
    this.report("atol.shift.opened","Фискальная смена АТОЛ открыта",{serial:this.connectedSerial});
  }

  async closeShift(operatorName?:string):Promise<{message:string;reportNumber?:string}> {
    const result=this.resultObject(await this.execute(buildAtolShiftJson("closeShift",operatorName??this.currentOperator())));
    const reportNumber=this.pick(result,["fiscalDocumentNumber","shiftNumber"]);
    this.report("atol.shift.closed","Фискальная смена АТОЛ закрыта",{serial:this.connectedSerial,fiscalDocument:reportNumber});
    return {message:"Фискальная смена закрыта",reportNumber};
  }

  async fiscalizeSale(request:FiscalRequest):Promise<FiscalResult> { return this.fiscalize("sell",request); }
  async fiscalizeReturn(request:FiscalReturnRequest):Promise<FiscalResult> { return this.fiscalize("sellReturn",request); }

  async captureRecoverySnapshot():Promise<FiscalRecoverySnapshot> {
    await this.ensureConnected();
    const probe=await this.bridge.recoveryProbe();
    const expected=this.settingsStore.load().direct?.selectedDevice?.serialNumber;
    if(!expected||probe.kktSerialNumber!==expected)
      throw new Error("Recovery snapshot получен не от выбранной ККТ АТОЛ");
    return {
      kktSerialNumber:String(probe.kktSerialNumber),
      shiftNumber:probe.shiftNumber===undefined?undefined:String(probe.shiftNumber),
      fiscalDocumentNumber:probe.fiscalDocumentNumber===undefined?undefined:String(probe.fiscalDocumentNumber),
      fiscalSign:probe.fiscalSign===undefined?undefined:String(probe.fiscalSign),
      kktDateTime:probe.kktDateTime,
      documentClosed:probe.documentClosed,
      receiptKind:probe.receiptKind,
      amountMinor:probe.amount===undefined?undefined:Math.round(probe.amount*100)
    };
  }

  async getOperationStatus(request:{
    operationId:string;entityId:string;kind:"sale"|"return";expectedAmountMinor:number;recovery?:FiscalRecoveryEvidence
  }):Promise<FiscalOperationStatus> {
    this.report("atol.recovery.started","Начата безопасная сверка фискальной операции",
      {serial:request.recovery?.snapshotBefore?.kktSerialNumber,shift:request.recovery?.snapshotBefore?.shiftNumber},
      "info",request.operationId);
    try {
      const before=request.recovery?.snapshotBefore;
      const selected=this.settingsStore.load().direct?.selectedDevice;
      if(!before?.kktSerialNumber||!request.recovery?.requestHash)
        return this.recoveryResult({status:"unknown",message:"Недостаточно сохранённых evidence для безопасной проверки ККТ"},request.operationId);
      if(!selected||selected.serialNumber!==before.kktSerialNumber)
        return this.recoveryResult({status:"unknown",message:"Выбранная ККТ не совпадает с ККТ исходной попытки"},request.operationId);

      const after=await this.captureRecoverySnapshot();
      if(after.kktSerialNumber!==before.kktSerialNumber)
        return this.recoveryResult({status:"unknown",message:"Recovery probe выполнен на другой ККТ",raw:{before,after}},request.operationId);

      const beforeNumber=this.number(before.fiscalDocumentNumber);
      const afterNumber=this.number(after.fiscalDocumentNumber);
      const sameShift=before.shiftNumber!==undefined&&after.shiftNumber===before.shiftNumber;
      const beforeTime=before.kktDateTime?Date.parse(before.kktDateTime):Number.NaN;
      const afterTime=after.kktDateTime?Date.parse(after.kktDateTime):Number.NaN;
      const timeOrdered=Number.isFinite(beforeTime)&&Number.isFinite(afterTime)&&afterTime>=beforeTime;
      const attemptTime=request.recovery?.attemptStartedAt?Date.parse(request.recovery.attemptStartedAt):Number.NaN;
      const nearAttempt=Number.isFinite(attemptTime)&&Number.isFinite(afterTime)&&
        afterTime>=attemptTime-2*60*1000&&afterTime<=attemptTime+10*60*1000;
      const receiptMatches=after.receiptKind===request.kind&&
        after.amountMinor===request.expectedAmountMinor&&sameShift&&timeOrdered&&nearAttempt;

      if(beforeNumber!==undefined&&afterNumber!==undefined&&afterNumber===beforeNumber+1&&receiptMatches)
        return this.recoveryResult({status:"fiscalized",receiptNumber:String(after.fiscalDocumentNumber),
          raw:{before,after,requestHash:request.recovery.requestHash}},request.operationId);

      const noProgress=beforeNumber!==undefined&&afterNumber!==undefined&&afterNumber===beforeNumber;
      if(noProgress&&after.documentClosed===true&&sameShift&&timeOrdered)
        return this.recoveryResult({status:"not_found",message:"ФН подтверждает отсутствие нового фискального документа",
          raw:{before,after,requestHash:request.recovery.requestHash}},request.operationId);

      return this.recoveryResult({status:"unknown",message:"Состояние ФН не доказывает ни выполнение, ни отсутствие чека",
        raw:{before,after,requestHash:request.recovery.requestHash}},request.operationId);
    } catch(error) {
      this.report("atol.recovery.unresolved","Сверка фискальной операции не завершена",
        this.errorDetails(error),"warning",request.operationId);
      throw error;
    }
  }

  async reprintReceipt(request:{saleId:string;receiptNumber:string}):Promise<PrintResult> {
    const documentNumber=String(request.receiptNumber||'').trim();
    if(!/^\d+$/.test(documentNumber)) throw new Error("Точная копия недоступна: чек не содержит числовой номер фискального документа ФН");
    await this.ensureConnected();
    await this.bridge.reprintDocument(documentNumber);
    return {kind:"fiscal-copy",status:"printed",message:"Копия фискального документа "+documentNumber+" отправлена на АТОЛ"};
  }

  private async fiscalize(type:"sell"|"sellReturn",request:FiscalRequest|FiscalReturnRequest):Promise<FiscalResult> {
    const settings=this.settingsStore.load();
    this.report("atol.fiscal.started","Начата фискализация через Драйвер ККТ 10",
      {serial:this.settingsStore.load().direct?.selectedDevice?.serialNumber,kind:type,amountMinor:request.amountMinor},
      "info",request.operationId);
    try {
      const result=await this.execute(buildAtolReceiptJson({
        type,amountMinor:request.amountMinor,payments:request.payments,lines:request.lines,
        taxationType:settings.taxationType,taxType:settings.taxType,operatorName:this.currentOperator()
      }));
      const fiscal=this.parseFiscalResult(this.resultObject(result));
      this.report("atol.fiscal.completed","Фискализация АТОЛ подтверждена",
        {serial:this.connectedSerial,kind:type,fiscalDocument:fiscal.fiscalDocumentNumber,
          fiscalSign:fiscal.fiscalSign,shift:fiscal.shiftNumber},"info",request.operationId);
      return fiscal;
    } catch(error) {
      this.report("atol.fiscal.unknown","Результат фискализации АТОЛ требует сверки",
        {serial:this.connectedSerial,kind:type,...this.errorDetails(error)},"warning",request.operationId);
      throw error;
    }
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
    this.report("atol.device.connected","Подключена выбранная ККТ АТОЛ",{
      serial:status.serialNumber,model:status.modelName,firmware:status.firmwareVersion,
      shift:status.shiftState,driverVersion:status.driverVersion,
    });
  }

  private recoveryResult(result:FiscalOperationStatus,operationId:string):FiscalOperationStatus {
    const eventType=result.status==="unknown"?"atol.recovery.unresolved":"atol.recovery.completed";
    this.report(eventType,
      result.status==="fiscalized"?"Фискальный документ подтверждён":"Сверка фискальной операции завершена",
      {fiscalDocument:result.receiptNumber,status:result.status},result.status==="unknown"?"warning":"info",operationId);
    return result;
  }

  private errorDetails(error:unknown):Record<string,unknown> {
    const value=error as {code?:unknown;driverErrorCode?:unknown;driverErrorDescription?:unknown};
    return {
      errorCode:value?.driverErrorCode??value?.code,
      errorDescription:value?.driverErrorDescription??(error instanceof Error?error.message:String(error)),
    };
  }

  private report(eventType:string,message:string,details:Record<string,unknown>,level:"info"|"warning"|"error"="info",operationId?:string):void {
    this.diagnostics?.record({source:"fiscal",level,eventType,message,details,operationId});
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

  private number(value:string|undefined):number|undefined {
    if(value===undefined)return undefined;
    const parsed=Number(value);
    return Number.isSafeInteger(parsed)?parsed:undefined;
  }

  private resultObject(value:Record<string,unknown>):Record<string,unknown>{ return this.object(value.result)??value; }
  private object(value:unknown):Record<string,unknown>|undefined { return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined; }
  private pick(source:Record<string,unknown>,keys:string[]):string|undefined { return pickAtolString(source,keys); }
}
