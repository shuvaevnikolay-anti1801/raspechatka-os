import type { Customer } from './contracts'

export async function resolveCurrentCustomer(
  customer:Customer|null|undefined,
  lookup:(id:string)=>Promise<Customer|null>
):Promise<Customer|null>{
  return customer?lookup(customer.id):null
}
