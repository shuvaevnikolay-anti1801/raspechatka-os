import type { CartLine, Product, UpsellCandidate, UpsellRule } from './contracts'

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
