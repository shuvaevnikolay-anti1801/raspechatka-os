import type { CartLine, DiscountBreakdown, DiscountRulesSnapshot, ManualDiscount } from './contracts'

export function calculateSubtotalMinor(lines: CartLine[]): number {
  return lines.reduce((total, line) => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error('Количество должно быть больше нуля')
    if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) throw new Error('Цена должна храниться целым числом копеек')
    const discount = Math.min(Math.max(line.discountPercent ?? 0, 0), 100)
    return total + Math.round(line.quantity * line.unitPriceMinor * (1 - discount / 100))
  }, 0)
}

export function calculateTotalMinor(lines: CartLine[], receiptDiscountPercent = 0): number {
  const discount = Math.min(Math.max(receiptDiscountPercent, 0), 100)
  return Math.round(calculateSubtotalMinor(lines) * (1 - discount / 100))
}

export function calculatePayableMinor(discountedTotalMinor: number): number {
  return Math.floor(discountedTotalMinor / 100) * 100
}

export function calculateDiscountBreakdown(
  lines: CartLine[],
  rules: DiscountRulesSnapshot,
  clubDiscountPercent = 0,
  reviewCount = 0,
  manualDiscount?: ManualDiscount | null,
): DiscountBreakdown {
  const subtotalMinor = calculateSubtotalMinor(lines)
  // Existing POS contract: one protected item blocks receipt-level discounts for the whole check.
  const discountableSubtotalMinor = lines.some((line)=>line.preventDiscounts) ? 0 : subtotalMinor
  if (!rules.allowDiscounts || subtotalMinor <= 0) {
    return {
      subtotalMinor, discountableSubtotalMinor, clubDiscountPercent: 0, clubDiscountMinor: 0,
      reviewCount: 0, reviewDiscountMinor: 0, manualDiscountValue: 0, manualDiscountMinor: 0,
      totalDiscountMinor: 0, totalMinor: subtotalMinor,
      roundingAdjustmentMinor: subtotalMinor - calculatePayableMinor(subtotalMinor),
      payableMinor: calculatePayableMinor(subtotalMinor),
    }
  }

  const maxPercent = Math.min(Math.max(rules.maxDiscountPercent || 0, 0), 100)
  const maxDiscountMinor = Math.min(
    Math.floor(discountableSubtotalMinor * maxPercent / 100),
    Math.max(subtotalMinor - 1, 0),
  )
  const allowedClubPercent = Math.min(Math.max(clubDiscountPercent || 0, 0), maxPercent)
  const clubDiscountMinor = Math.min(
    Math.round(discountableSubtotalMinor * allowedClubPercent / 100),
    maxDiscountMinor,
  )
  const afterClub = subtotalMinor - clubDiscountMinor
  const requestedReviewCount = Math.max(0, Math.trunc(reviewCount || 0))
  const reviewUnitMinor = Math.max(0, Math.trunc(rules.reviewDiscountPerReviewMinor || 0))
  const reviewCapacity = Math.min(maxDiscountMinor - clubDiscountMinor, Math.max(afterClub - 1, 0))
  const appliedReviewCount = reviewUnitMinor > 0 ? Math.min(requestedReviewCount, Math.floor(reviewCapacity / reviewUnitMinor)) : 0
  const reviewDiscountMinor = appliedReviewCount * reviewUnitMinor
  const afterReview = afterClub - reviewDiscountMinor
  const manualDiscountValue = Math.max(0, Number(manualDiscount?.value || 0))
  const requestedManual = manualDiscount?.type === 'percent'
    ? Math.round(afterReview * Math.min(manualDiscountValue, 100) / 100)
    : Math.round(manualDiscountValue)
  const manualDiscountMinor = Math.min(
    requestedManual,
    maxDiscountMinor - clubDiscountMinor - reviewDiscountMinor,
    Math.max(afterReview - 1, 0),
  )
  const totalDiscountMinor = clubDiscountMinor + reviewDiscountMinor + manualDiscountMinor
  const discountedTotalMinor = subtotalMinor - totalDiscountMinor
  const payableMinor = calculatePayableMinor(discountedTotalMinor)
  return {
    subtotalMinor, discountableSubtotalMinor, clubDiscountPercent: clubDiscountMinor > 0 ? allowedClubPercent : 0, clubDiscountMinor,
    reviewCount: appliedReviewCount, reviewDiscountMinor,
    manualDiscountType: manualDiscount?.type, manualDiscountValue, manualDiscountMinor,
    totalDiscountMinor, totalMinor: discountedTotalMinor,
    roundingAdjustmentMinor: discountedTotalMinor - payableMinor, payableMinor,
  }
}
