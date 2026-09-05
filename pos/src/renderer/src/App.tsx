import { useEffect, useMemo, useState } from 'react'
import { calculateTotalMinor } from '../../shared/cart'
import type { BootState, CartLine, PaymentMethod, Product } from '../../shared/contracts'

const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })
const formatMoney = (minor: number): string => money.format(minor / 100)

export default function App() {
  const [boot, setBoot] = useState<BootState | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [query, setQuery] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    Promise.all([window.raspechatkaPos.getBootState(), window.raspechatkaPos.listProducts()])
      .then(([state, catalog]) => {
        setBoot(state)
        setProducts(catalog)
      })
      .catch((error) => setMessage(String(error)))
  }, [])

  const visibleProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ru')
    if (!normalized) return products
    return products.filter((product) =>
      `${product.name} ${product.sku} ${product.category}`.toLocaleLowerCase('ru').includes(normalized)
    )
  }, [products, query])

  const totalMinor = calculateTotalMinor(cart)

  const addProduct = (product: Product) => {
    setCart((current) => {
      const existing = current.find((line) => line.productId === product.id)
      if (existing) {
        return current.map((line) => line.productId === product.id
          ? { ...line, quantity: line.quantity + 1 }
          : line)
      }
      return [...current, {
        productId: product.id,
        name: product.name,
        quantity: 1,
        unitPriceMinor: product.priceMinor
      }]
    })
  }

  const changeQuantity = (productId: string, delta: number) => {
    setCart((current) => current
      .map((line) => line.productId === productId ? { ...line, quantity: line.quantity + delta } : line)
      .filter((line) => line.quantity > 0))
  }

  const openShift = async () => {
    const shift = await window.raspechatkaPos.openShift()
    setBoot((current) => current ? { ...current, shift } : current)
    setMessage('Смена открыта')
  }

  const pay = async (paymentMethod: PaymentMethod) => {
    if (!cart.length || busy) return
    setBusy(true)
    setMessage('')
    try {
      const result = await window.raspechatkaPos.completeSale({
        clientRequestId: crypto.randomUUID(),
        paymentMethod,
        lines: cart
      })
      setCart([])
      const nextBoot = await window.raspechatkaPos.getBootState()
      setBoot(nextBoot)
      setMessage(`Тестовый чек ${result.receiptNumber} сохранён. К отправке: ${nextBoot.pendingSync}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (!boot) return <div className="loading">Запускаем кассу…</div>

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Р</span>
          <div><strong>Распечатка</strong><span>рабочее место</span></div>
        </div>
        <div className="workplace">
          <span>{boot.pointName}</span><strong>{boot.workstationName}</strong>
        </div>
        <div className="status-row">
          <span className={boot.online ? 'status online' : 'status offline'}>{boot.online ? 'Связь есть' : 'Офлайн'}</span>
          <span className="sync">К отправке: {boot.pendingSync}</span>
          <span className="cashier">{boot.cashierName}</span>
        </div>
      </header>

      <nav className="nav-tabs">
        <button className="active">Продажа</button>
        <button disabled>Возврат</button>
        <button disabled>Заказы</button>
        <button disabled>Смена</button>
        <button disabled>Ещё</button>
      </nav>

      <main className="workspace">
        <section className="catalog-panel">
          <div className="catalog-head">
            <div><h1>Товары и услуги</h1><p>Демо-каталог первой кассы</p></div>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Название, артикул или штрихкод"
            />
          </div>
          <div className="product-grid">
            {visibleProducts.map((product) => (
              <button className="product-card" key={product.id} onClick={() => addProduct(product)}>
                <span className="product-category">{product.category}</span>
                <strong>{product.name}</strong>
                <small>{product.sku}</small>
                <b>{formatMoney(product.priceMinor)}</b>
              </button>
            ))}
          </div>
        </section>

        <aside className="receipt-panel">
          <div className="receipt-head">
            <div><h2>Новый чек</h2><span>{cart.length ? `${cart.length} поз.` : 'Пусто'}</span></div>
            {cart.length > 0 && <button className="link-button" onClick={() => setCart([])}>Очистить</button>}
          </div>

          <div className="receipt-lines">
            {cart.length === 0 ? (
              <div className="empty-cart"><span>＋</span><strong>Добавьте товар</strong><p>Нажмите на карточку слева или найдите товар</p></div>
            ) : cart.map((line) => (
              <div className="receipt-line" key={line.productId}>
                <div className="line-title"><strong>{line.name}</strong><span>{formatMoney(line.unitPriceMinor)} × {line.quantity}</span></div>
                <div className="quantity">
                  <button onClick={() => changeQuantity(line.productId, -1)}>−</button>
                  <b>{line.quantity}</b>
                  <button onClick={() => changeQuantity(line.productId, 1)}>+</button>
                </div>
                <strong>{formatMoney(line.quantity * line.unitPriceMinor)}</strong>
              </div>
            ))}
          </div>

          <div className="receipt-footer">
            {message && <div className="message">{message}</div>}
            {!boot.shift ? (
              <button className="open-shift" onClick={openShift}>Открыть смену</button>
            ) : (
              <div className="shift-open"><span>Смена открыта</span><small>{new Date(boot.shift.openedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</small></div>
            )}
            <div className="total"><span>Итого</span><strong>{formatMoney(totalMinor)}</strong></div>
            <div className="payment-buttons">
              <button disabled={!cart.length || !boot.shift || busy} onClick={() => pay('cash')}>Наличные</button>
              <button className="primary" disabled={!cart.length || !boot.shift || busy} onClick={() => pay('card')}>Картой</button>
            </div>
            <small className="demo-warning">Учебный режим: реальная касса и терминал пока не вызываются</small>
          </div>
        </aside>
      </main>
    </div>
  )
}
