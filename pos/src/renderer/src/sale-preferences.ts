export const SALE_PREFERENCES_KEY='raspechatka.pos.sale-preferences.v1'

export type SaleLayoutRatios={categoriesRatio:number;receiptRatio:number}
export type SalePreferencesV1={
  version:1
  layout:SaleLayoutRatios
  favoriteProductIds:string[]
}

export const DEFAULT_SALE_LAYOUT:SaleLayoutRatios={categoriesRatio:0.16,receiptRatio:0.34}
export const DEFAULT_SALE_PREFERENCES:SalePreferencesV1={
  version:1,
  layout:DEFAULT_SALE_LAYOUT,
  favoriteProductIds:[],
}

export const SALE_LAYOUT_LIMITS={
  splitterWidth:12,
  categoriesMin:160,
  categoriesMaxRatio:0.24,
  receiptMin:320,
  receiptMaxRatio:0.42,
  catalogMin:420,
} as const

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)
const bounded=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value))

export const clampSaleLayout=(value:Partial<SaleLayoutRatios>|null|undefined,containerWidth:number):SaleLayoutRatios=>{
  const usable=Math.max(1,containerWidth-SALE_LAYOUT_LIMITS.splitterWidth*2)
  const categoriesMinRatio=Math.min(SALE_LAYOUT_LIMITS.categoriesMaxRatio,SALE_LAYOUT_LIMITS.categoriesMin/usable)
  const receiptMinRatio=Math.min(SALE_LAYOUT_LIMITS.receiptMaxRatio,SALE_LAYOUT_LIMITS.receiptMin/usable)
  let categoriesRatio=bounded(
    finite(value?.categoriesRatio)?value.categoriesRatio:DEFAULT_SALE_LAYOUT.categoriesRatio,
    categoriesMinRatio,
    SALE_LAYOUT_LIMITS.categoriesMaxRatio,
  )
  let receiptRatio=bounded(
    finite(value?.receiptRatio)?value.receiptRatio:DEFAULT_SALE_LAYOUT.receiptRatio,
    receiptMinRatio,
    SALE_LAYOUT_LIMITS.receiptMaxRatio,
  )
  const maxSides=Math.max(0,1-Math.min(1,SALE_LAYOUT_LIMITS.catalogMin/usable))
  const overflow=categoriesRatio+receiptRatio-maxSides
  if(overflow>0){
    const receiptRoom=Math.max(0,receiptRatio-receiptMinRatio)
    const fromReceipt=Math.min(overflow,receiptRoom)
    receiptRatio-=fromReceipt
    categoriesRatio=Math.max(categoriesMinRatio,categoriesRatio-(overflow-fromReceipt))
  }
  return {categoriesRatio,receiptRatio}
}

export const parseSalePreferences=(raw:string|null,containerWidth:number):SalePreferencesV1=>{
  if(!raw)return {...DEFAULT_SALE_PREFERENCES,layout:clampSaleLayout(DEFAULT_SALE_LAYOUT,containerWidth)}
  try{
    const value:unknown=JSON.parse(raw)
    if(!value||typeof value!=='object'||(value as {version?:unknown}).version!==1)return {...DEFAULT_SALE_PREFERENCES,layout:clampSaleLayout(DEFAULT_SALE_LAYOUT,containerWidth)}
    const candidate=value as {layout?:Partial<SaleLayoutRatios>;favoriteProductIds?:unknown}
    const favoriteProductIds=Array.isArray(candidate.favoriteProductIds)
      ? [...new Set(candidate.favoriteProductIds.filter((id):id is string=>typeof id==='string'&&id.length>0))]
      : []
    return {version:1,layout:clampSaleLayout(candidate.layout,containerWidth),favoriteProductIds}
  }catch{
    return {...DEFAULT_SALE_PREFERENCES,layout:clampSaleLayout(DEFAULT_SALE_LAYOUT,containerWidth)}
  }
}

export const pruneFavoriteProductIds=(favoriteProductIds:readonly string[],productIds:readonly string[])=>{
  const available=new Set(productIds)
  return [...new Set(favoriteProductIds.filter((id)=>available.has(id)))]
}

export const toggleFavoriteProductId=(favoriteProductIds:readonly string[],productId:string)=>
  favoriteProductIds.includes(productId)
    ? favoriteProductIds.filter((id)=>id!==productId)
    : [...favoriteProductIds,productId]

export const readSalePreferences=(containerWidth:number,storage:Pick<Storage,'getItem'>=window.localStorage)=>
  parseSalePreferences(storage.getItem(SALE_PREFERENCES_KEY),containerWidth)

export const writeSalePreferences=(preferences:SalePreferencesV1,storage:Pick<Storage,'setItem'>=window.localStorage)=>
  storage.setItem(SALE_PREFERENCES_KEY,JSON.stringify(preferences))
