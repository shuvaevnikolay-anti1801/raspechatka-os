import type { CartLine, Product, UpsellCandidate, UpsellRule } from './contracts'

export function findUpsellRuleForProduct(rules:UpsellRule[],productId:string):UpsellRule|undefined {
  return rules.find((rule)=>rule.enabled&&rule.triggerItem===productId)
}

export type UpsellSelection = {
  candidate: UpsellCandidate | null
  nextCursor: number
}

export function selectUpsellCandidate(
  rule: UpsellRule,
  products: Product[],
  cart: CartLine[],
  cursor = 0,
): UpsellSelection {
  const candidates = rule.enabled ? rule.candidates : []
  if (!candidates.length) return { candidate: null, nextCursor: 0 }

  const productById = new Map(products.map((product) => [product.id, product]))
  const inCart = new Set(cart.map((line) => line.productId))
  const start = ((Math.trunc(cursor) % candidates.length) + candidates.length) % candidates.length

  for (let offset = 0; offset < candidates.length; offset += 1) {
    const index = (start + offset) % candidates.length
    const candidate = candidates[index]
    const product = productById.get(candidate.item)
    if (!product || inCart.has(candidate.item)) continue
    if (product.trackInventory && Number(product.stock ?? 0) <= 0 && !product.allowNegativeStock) continue
    return { candidate, nextCursor: (index + 1) % candidates.length }
  }

  return { candidate: null, nextCursor: start }
}


export type UpsellCycleState = 'eligible' | 'showing' | 'resolved'
export type UpsellCycle = {
  state: UpsellCycleState
  triggerItem?: string
  candidate?: UpsellCandidate
}

export function resolveUpsellAfterCart(cycle: UpsellCycle, cart: CartLine[]): UpsellCycle {
  if (cycle.state === 'showing' && cycle.triggerItem && !cart.some((line) => line.productId === cycle.triggerItem)) {
    return { state: 'resolved' }
  }
  return cycle
}
