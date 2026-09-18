import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { CashierAuthState, PointEmployee } from '../shared/contracts'
import { PosDatabase } from './database'

const ADMIN_CODE='0000'
const PIN_PATTERN=/^\d{4}$/

const verifier=(pin:string,salt:string)=>scryptSync(pin,Buffer.from(salt,'hex'),32).toString('hex')

export const verifyAdminCode=(code:string):boolean=>{
  const supplied=Buffer.from(String(code||''))
  const expected=Buffer.from(ADMIN_CODE)
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected)
}

export class CashierAuthSession {
  private employee?:PointEmployee
  private locked=false

  constructor(private readonly database:PosDatabase){}

  state():CashierAuthState{
    const shift=this.database.currentShift()
    return {
      status:this.employee?(this.locked?'locked':'authenticated'):'signed_out',
      employee:this.employee,
      openShiftCashierId:shift?.cashierId,
      openShiftCashierName:shift?.cashierName
    }
  }

  begin(employeeId:string):{requiresPinSetup:boolean}{
    this.allowed(employeeId)
    return {requiresPinSetup:!this.database.hasCashierPin(employeeId)}
  }

  createPin(employeeId:string,pin:string,confirmation:string):CashierAuthState{
    const employee=this.allowed(employeeId)
    this.assertPin(pin)
    if(pin!==confirmation)throw new Error('PIN и подтверждение не совпадают')
    if(this.database.hasCashierPin(employeeId))throw new Error('PIN уже создан. Введите его или выполните сброс администратором.')
    this.database.saveCashierPin(employeeId,this.hash(pin))
    return this.authenticate(employee)
  }

  login(employeeId:string,pin:string):CashierAuthState{
    const employee=this.allowed(employeeId)
    const saved=this.database.getCashierPin(employeeId)
    if(!saved)throw new Error('Для кассира ещё не создан локальный PIN')
    if(!this.matches(pin,saved))throw new Error('Неверный PIN')
    return this.authenticate(employee)
  }

  lock():CashierAuthState{
    if(!this.employee)throw new Error('Кассир не вошёл')
    this.locked=true
    return this.state()
  }

  unlock(pin:string):CashierAuthState{
    if(!this.employee||!this.locked)throw new Error('Касса не заблокирована')
    const saved=this.database.getCashierPin(this.employee.id)
    if(!saved||!this.matches(pin,saved))throw new Error('Неверный PIN')
    this.locked=false
    return this.state()
  }

  logout():CashierAuthState{
    if(this.database.currentShift())throw new Error('Сначала закройте смену')
    this.employee=undefined
    this.locked=false
    return this.state()
  }

  resetPin(employeeId:string,adminCode:string,pin:string,confirmation:string):void{
    const employee=this.allowed(employeeId)
    if(!verifyAdminCode(adminCode))throw new Error('Неверный код администратора')
    this.assertPin(pin)
    if(pin!==confirmation)throw new Error('PIN и подтверждение не совпадают')
    this.database.saveCashierPin(employee.id,this.hash(pin))
  }

  requireAuthenticated(options:{allowRevokedForClose?:boolean}={}):PointEmployee{
    if(!this.employee||this.locked)throw new Error(this.locked?'Касса заблокирована. Введите PIN кассира.':'Сначала выберите кассира и войдите по PIN')
    const allowed=this.database.listPointEmployees().some((row)=>row.id===this.employee!.id)
    if(!allowed&&!options.allowRevokedForClose)throw new Error('Доступ кассира отозван. Разрешено только безопасно закрыть открытую смену.')
    return this.employee
  }

  private allowed(employeeId:string):PointEmployee{
    const shift=this.database.currentShift()
    const employee=this.database.listPointEmployees().find((row)=>row.id===employeeId)
      ||(shift&&shift.cashierId===employeeId?{id:employeeId,name:shift.cashierName}:undefined)
    if(!employee)throw new Error('Кассир не входит в подтверждённый список этой точки')
    if(shift&&((shift.cashierId&&shift.cashierId!==employeeId)||(!shift.cashierId&&shift.cashierName!==employee.name)))throw new Error(`Открытую смену может продолжить только ${shift.cashierName}`)
    return employee
  }

  private authenticate(employee:PointEmployee):CashierAuthState{
    this.employee=employee
    this.locked=false
    return this.state()
  }

  private assertPin(pin:string):void{
    if(!PIN_PATTERN.test(pin))throw new Error('PIN должен состоять ровно из 4 цифр')
    if(verifyAdminCode(pin))throw new Error('Код 0000 зарезервирован для администратора')
  }

  private hash(pin:string):{salt:string;verifier:string}{
    const salt=randomBytes(16).toString('hex')
    return {salt,verifier:verifier(pin,salt)}
  }

  private matches(pin:string,saved:{salt:string;verifier:string}):boolean{
    if(!PIN_PATTERN.test(pin))return false
    const actual=Buffer.from(verifier(pin,saved.salt),'hex')
    const expected=Buffer.from(saved.verifier,'hex')
    return actual.length===expected.length&&timingSafeEqual(actual,expected)
  }
}
