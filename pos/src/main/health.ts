import type { BootState, DeviceStatuses, HardwareStatus } from '../shared/contracts'
import type { FiscalProvider, PaymentProvider, PrintProvider } from './providers/contracts'

type HealthSources = {
  boot: BootState
  connectionConfigured: boolean
  localOpen: boolean
  fiscal: Pick<FiscalProvider, 'healthCheck'|'getShiftStatus'|'ofdDeliveryHealth'>
  payment: Pick<PaymentProvider, 'healthCheck'>
  printer: Pick<PrintProvider, 'healthCheck'>
}

async function check(
  health:()=>Promise<HardwareStatus>,
  fallback:string
):Promise<HardwareStatus>{
  try{return await health()}
  catch{return {ready:false,status:'unknown',message:fallback}}
}

export async function collectDeviceStatuses(source:HealthSources):Promise<DeviceStatuses>{
  const {boot,connectionConfigured,localOpen}=source
  const [shiftResult,fiscal,payment,printer,ofd]=await Promise.all([
    source.fiscal.getShiftStatus().then(
      (value)=>({open:value.open,expired:value.state==='expired',message:value.message}),
      ()=>({open:undefined,expired:false,message:'Состояние фискальной смены не проверено'})
    ),
    check(()=>source.fiscal.healthCheck(),'Состояние ККТ и ФН не проверено'),
    check(()=>source.payment.healthCheck(),'Состояние терминала не проверено'),
    check(()=>source.printer.healthCheck(),'Состояние принтера не проверено'),
    source.fiscal.ofdDeliveryHealth
      ?check(()=>source.fiscal.ofdDeliveryHealth!(),'Нет подтверждённых данных о передаче в ОФД')
      :Promise.resolve({ready:false,status:'not_available',message:'Провайдер не предоставляет состояние ОФД'} as HardwareStatus),
  ])
  const fiscalOpen=shiftResult.open
  const shiftReady=fiscalOpen!==undefined&&localOpen===fiscalOpen&&!shiftResult.expired
  const os:HardwareStatus={
    ready:boot.online,
    status:boot.online?'ready':'offline',
    message:boot.online?`OS на связи · к отправке ${boot.pendingSync}`:`Локальный режим · к отправке ${boot.pendingSync}`,
    details:{pendingSync:boot.pendingSync,lastSyncAt:boot.lastSyncAt},
  }
  const remotePayment:HardwareStatus=!connectionConfigured||boot.rules.acceptsRemotePayment===false
    ?{ready:false,status:'not_configured',message:'Удалённая оплата не настроена для этой точки'}
    :boot.online
      ?{ready:true,status:'ready',message:'Канал удалённой оплаты доступен'}
      :{ready:false,status:'offline',message:'Для удалённой оплаты нужна связь с OS'}
  return {
    os,fiscal,ofd,payment,remotePayment,printer,
    shift:{
      ready:shiftReady,localOpen,fiscalOpen,
      message:shiftResult.expired
        ?'Фискальная смена АТОЛ истекла — продажи заблокированы до закрытия и открытия новой смены'
        :fiscalOpen===undefined
          ?`ККТ: ${shiftResult.message}`
          :localOpen===fiscalOpen
            ?(localOpen?'Локальная и фискальная смены открыты':'Локальная и фискальная смены закрыты')
            :`Несоответствие смен: локальная ${localOpen?'открыта':'закрыта'}, ККТ ${fiscalOpen?'открыта':'закрыта'}`,
    },
    paymentMethods:{
      cash:boot.rules.acceptsCash,
      card:boot.rules.acceptsCard&&payment.ready,
      qr:boot.rules.acceptsQr&&payment.ready,
      remote_payment:remotePayment.ready,
    },
  }
}
