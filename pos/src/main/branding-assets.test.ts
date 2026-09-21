import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const file=(relative:string)=>fileURLToPath(new URL(relative,import.meta.url))

const decodeRgbaPng=(buffer:Buffer)=>{
  expect(buffer.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a')
  let offset=8
  let width=0
  let height=0
  let colorType=-1
  const idat:Buffer[]=[]
  while(offset<buffer.length){
    const length=buffer.readUInt32BE(offset)
    const type=buffer.subarray(offset+4,offset+8).toString('ascii')
    const data=buffer.subarray(offset+8,offset+8+length)
    if(type==='IHDR'){
      width=data.readUInt32BE(0)
      height=data.readUInt32BE(4)
      expect(data[8]).toBe(8)
      colorType=data[9]
    }else if(type==='IDAT')idat.push(data)
    offset+=12+length
    if(type==='IEND')break
  }
  expect(colorType).toBe(6)
  const encoded=inflateSync(Buffer.concat(idat))
  const bpp=4
  const stride=width*bpp
  const rgba=Buffer.alloc(stride*height)
  const paeth=(a:number,b:number,c:number)=>{
    const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c)
    return pa<=pb&&pa<=pc?a:pb<=pc?b:c
  }
  let source=0
  for(let y=0;y<height;y+=1){
    const filter=encoded[source++]
    for(let x=0;x<stride;x+=1){
      const raw=encoded[source++]
      const left=x>=bpp?rgba[y*stride+x-bpp]:0
      const up=y>0?rgba[(y-1)*stride+x]:0
      const upperLeft=y>0&&x>=bpp?rgba[(y-1)*stride+x-bpp]:0
      const value=
        filter===0?raw:
        filter===1?(raw+left):
        filter===2?(raw+up):
        filter===3?(raw+Math.floor((left+up)/2)):
        filter===4?(raw+paeth(left,up,upperLeft)):
        Number.NaN
      if(!Number.isFinite(value))throw new Error('Unsupported PNG filter '+filter)
      rgba[y*stride+x]=value&255
    }
  }
  return {width,height,rgba,alpha:(x:number,y:number)=>rgba[y*stride+x*4+3]}
}

const icoSizes=(buffer:Buffer)=>{
  expect(buffer.readUInt16LE(0)).toBe(0)
  expect(buffer.readUInt16LE(2)).toBe(1)
  const count=buffer.readUInt16LE(4)
  return Array.from({length:count},(_,index)=>{
    const offset=6+index*16
    const width=buffer[offset]||256
    const height=buffer[offset+1]||256
    return `${width}x${height}`
  })
}

describe('DEV-159 branding assets',()=>{
  it('keeps the existing app artwork but makes PNG outer corners transparent',()=>{
    const png=decodeRgbaPng(readFileSync(file('../../build/icon.png')))
    expect([png.width,png.height]).toEqual([256,256])
    expect(png.alpha(0,0)).toBe(0)
    expect(png.alpha(255,0)).toBe(0)
    expect(png.alpha(0,255)).toBe(0)
    expect(png.alpha(255,255)).toBe(0)
    expect(png.alpha(128,128)).toBeGreaterThan(0)
  })

  it('packages a multi-size Windows ICO through electron-builder',()=>{
    const sizes=icoSizes(readFileSync(file('../../build/icon.ico')))
    expect(sizes).toEqual(expect.arrayContaining(['16x16','32x32','48x48','256x256']))
    const pkg=JSON.parse(readFileSync(file('../../package.json'),'utf8'))
    expect(pkg.build.win.icon).toBe('build/icon.ico')
    expect(pkg.build.files).toContain('build/icon.png')
  })

  it('uses the same corrected mark as the Web OS favicon at the production asset path',()=>{
    const appIcon=readFileSync(file('../../build/icon.png'))
    const favicon=readFileSync(file('../../../frontend/public/favicon.png'))
    expect(favicon.equals(appIcon)).toBe(true)
    const html=readFileSync(file('../../../frontend/index.html'),'utf8')
    expect(html).toContain('href="/assets/raspechatka/frontend/favicon.png"')
  })
})
