import type { DeviceHealth, PaymentProvider, PaymentRequest, PaymentResult } from './contracts'

export class UnavailablePaymentProvider implements PaymentProvider {
  async healthCheck():Promise<DeviceHealth>{
    return {ready:false,status:'not_configured',message:'PAX / Точка ещё не подключён'}
  }

  async charge(_request:PaymentRequest):Promise<PaymentResult>{
    throw new Error('Эквайринговый терминал ещё не настроен. Используйте наличные или подтверждённую удалённую оплату.')
  }

  async refund(_request:PaymentRequest):Promise<PaymentResult>{
    throw new Error('Возврат через эквайринговый терминал недоступен до подключения PAX / Точка.')
  }

  async getOperationStatus(_request:PaymentRequest):Promise<PaymentResult>{
    return {status:'unknown',message:'Невозможно проверить банковскую операцию: терминал ещё не настроен'}
  }
}
