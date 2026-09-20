export const formatPersonShortName=(value?:string|null):string=>{
  const parts=(value??'').trim().split(/\s+/).filter(Boolean)
  if(parts.length<=1)return parts[0]??''
  const [surname,...names]=parts
  const initials=names.map((part)=>Array.from(part.replace(/\./g,''))[0]).filter(Boolean).map((letter)=>letter+'.')
  return initials.length?surname+' '+initials.join(' '):surname
}
