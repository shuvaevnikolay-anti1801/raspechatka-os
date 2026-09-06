import type { BootState, ConnectionConfig, Product } from '../shared/contracts'

type BootstrapResponse = {
  point: { id:string; name:string }
  workplace: { name:string }
  employee: { name:string }
  rules: BootState['rules']
  products: Product[]
}

function checkedServerUrl(value:string):URL {
  const url=new URL(value)
  if(!['http:','https:'].includes(url.protocol)) throw new Error('Адрес OS должен начинаться с http:// или https://')
  return url
}

export async function loadBootstrap(config:ConnectionConfig):Promise<BootstrapResponse> {
  const url=checkedServerUrl(config.serverUrl)
  url.pathname='/api/method/raspechatka.api.pos.get_bootstrap'
  if(config.workplaceCode) url.searchParams.set('workplace_code',config.workplaceCode)
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(),10000)
  try {
    const response=await fetch(url,{
      headers:{ Authorization:`token ${config.apiKey}:${config.apiSecret}`,Accept:'application/json' },
      signal:controller.signal
    })
    const payload=await response.json() as {message?:BootstrapResponse;exception?:string}
    if(!response.ok || !payload.message) throw new Error(payload.exception || `OS ответила с кодом ${response.status}`)
    return payload.message
  } finally { clearTimeout(timer) }
}
